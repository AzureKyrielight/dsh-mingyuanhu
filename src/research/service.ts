import { createHash } from "node:crypto";
import type { WebRuntime, WebSearchSource } from "@deepseek-ai/dsh-web";
import { z } from "zod";
import {
  attachmentPattern,
  canonicalUrl,
  extractHtml,
  publicUrl,
} from "./html.js";
import {
  parseWechatSearch,
  wechatChallenge,
  wechatQueries,
  wechatSearchUrl,
  type WechatHit,
} from "./wechat.js";

export const categories = [
  "recruitment",
  "tech-events",
  "postgraduate",
  "innovation",
  "general",
] as const;
export const searchSchema = z
  .object({
    category: z.enum(categories).default("general"),
    query: z.string().trim().min(1).max(300),
    college: z.string().trim().min(1).max(80).optional(),
    year: z.number().int().min(1900).max(2200).optional(),
    maxQueries: z.number().int().min(1).max(4).default(4),
    maxResults: z.number().int().min(1).max(20).default(10),
    wechat: z.boolean().optional(),
  })
  .strict();
export const readSchema = z
  .object({
    url: z.string().max(4096),
    offset: z.number().int().min(0).default(0),
    maxChars: z.number().int().min(1).max(20000).default(12000),
    refresh: z.boolean().default(false),
    snapshotId: z.string().max(64).optional(),
  })
  .strict();
export type SearchInput = z.input<typeof searchSchema>;
export type ReadInput = z.input<typeof readSchema>;
type Source =
  | "official"
  | "wechat"
  | "wechat-search"
  | "company"
  | "job-board"
  | "other-university"
  | "web";
const rank: Record<Source, number> = {
  official: 0,
  "other-university": 1,
  wechat: 2,
  "wechat-search": 3,
  company: 4,
  "job-board": 5,
  web: 6,
};
const belongs = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
export function sourceOf(url: string): Source {
  const host = new URL(url).hostname;
  if (belongs(host, "scu.edu.cn")) return "official";
  if (host === "weixin.sogou.com") return "wechat-search";
  if (host === "mp.weixin.qq.com") return "wechat";
  if (host.endsWith(".edu.cn")) return "other-university";
  if (
    [
      "zhaopin.com",
      "51job.com",
      "liepin.com",
      "zhipin.com",
      "nowcoder.com",
      "yingjiesheng.com",
      "shixiseng.com",
    ].some((d) => belongs(host, d))
  )
    return "job-board";
  // A narrow explicit list, not an assertion that all .com pages are companies.
  if (
    [
      "huawei.com",
      "tencent.com",
      "alibaba.com",
      "bytedance.com",
      "baidu.com",
      "jd.com",
    ].some((d) => belongs(host, d))
  )
    return "company";
  return "web";
}
const keywords = {
  recruitment: "校园招聘 宣讲会 实习",
  "tech-events": "技术讲座 学术报告 技术活动",
  postgraduate: "研究生 推免 保研 招生",
  innovation: "创新创业 竞赛 大创",
  general: "通知 公告",
};
/** 学院级活动常以「活动预告 / 宣讲会 / 双选会 / 信息一览」这类标题发布，纯招聘词召回不到。 */
const activityWords = {
  recruitment: "活动预告 双选会 信息一览",
  "tech-events": "活动预告 报名 讲座",
  postgraduate: "通知 公示 细则",
  innovation: "通知 立项 申报",
  general: "通知 公告",
};
const timeSensitive = new Set(["recruitment", "tech-events"]);
export function expandQueries(
  input: z.output<typeof searchSchema>,
  now = Date.now(),
) {
  const base = ["四川大学", input.college, input.year, input.query]
    .filter((v) => v !== undefined)
    .join(" ");
  const month = `${new Date(now).getMonth() + 1}月`;
  const fourth = timeSensitive.has(input.category)
    ? `${base} ${activityWords[input.category]} ${month}`
    : `${base} ${activityWords[input.category]}`;
  return [
    `site:scu.edu.cn ${base} ${keywords[input.category]}`,
    `${base} ${keywords[input.category]}`,
    `site:mp.weixin.qq.com ${base} ${keywords[input.category]}`,
    fourth,
  ].slice(0, input.maxQueries);
}
function abort(signal: AbortSignal) {
  signal.throwIfAborted();
}
const clipped = (value: string | undefined, length: number) =>
  (value ?? "").replace(/\s+/g, " ").trim().slice(0, length);

/** No campus client, credentials, headers, or raw networking is accepted here. */
export class ResearchService {
  private active = 0;
  private waiters: {
    start: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
  }[] = [];
  private cache = new Map<string, { page: Page; expires: number }>();
  constructor(
    private readonly web: Pick<WebRuntime, "search" | "fetch">,
    private readonly now = Date.now,
  ) {}

  private async request<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    abort(signal);
    if (this.active >= 2) {
      if (this.waiters.length >= 16)
        throw new Error("公开研究请求队列已满，请稍后再试");
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          start: () => {
            signal.removeEventListener("abort", cancelled);
            resolve();
          },
          reject,
          signal,
        };
        const cancelled = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancelled, { once: true });
        this.waiters.push(waiter);
      });
    } else this.active++;
    try {
      abort(signal);
      const result = await operation();
      abort(signal);
      return result;
    } finally {
      const next = this.waiters.shift();
      if (next) next.start();
      else this.active--;
    }
  }

  async search(raw: SearchInput, caller?: AbortSignal) {
    const input = searchSchema.parse(raw);
    const signal = caller
      ? AbortSignal.any([caller, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    abort(signal);
    const queries = expandQueries(input, this.now());
    const [outcomes, wechatReport] = await Promise.all([
      Promise.all(
        queries.map(async (query) => {
          try {
            const value = await this.request(
              () =>
                this.web.search(
                  { query, maxResults: input.maxResults },
                  signal,
                ),
              signal,
            );
            return {
              query,
              value,
              fetchedAt: new Date(this.now()).toISOString(),
            };
          } catch (error) {
            abort(signal);
            // Provider messages can contain credentials/request URLs. Only report a bounded code.
            const code =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[A-Z_0-9]{1,80}$/.test(error.code)
                ? error.code
                : "SEARCH_FAILED";
            return { query, error: code };
          }
        }),
      ),
      this.wantsWechat(input)
        ? this.discoverWechat(input, signal)
        : Promise.resolve<WechatReport>({
            status: "skipped" as const,
            queries: [],
            searchUrl: null,
            hits: [],
          }),
    ]);
    abort(signal);
    // 宿主搜索全挂时，若微信结果页仍有线索就不当众失败；两者都没有才报错。
    if (outcomes.every((o) => !o.value) && wechatReport.status !== "ok")
      throw new Error(
        `全部 ${queries.length} 路公开搜索失败（${outcomes.map((o) => o.error).join(", ")}）；不是零条结果`,
      );
    const results = new Map<string, SearchResult>();
    let invalidSources = 0;
    for (const outcome of outcomes) {
      for (const source of outcome.value?.sources.slice(0, input.maxResults) ??
        []) {
        try {
          const hit = normalize(source, outcome.fetchedAt!, input.year);
          if (!results.has(hit.url)) results.set(hit.url, hit);
        } catch {
          invalidSources++;
        }
      }
    }
    const wechatFetchedAt = new Date(this.now()).toISOString();
    let wechatIncluded = 0;
    if (wechatReport.status === "ok") {
      const titles = new Set([...results.values()].map((hit) => hit.title));
      for (const hit of wechatReport.hits) {
        if (results.has(hit.url) || titles.has(hit.title)) continue;
        const entry = normalizeWechat(hit, wechatFetchedAt, input.year);
        results.set(entry.url, entry);
        titles.add(entry.title);
        wechatIncluded++;
      }
    }
    const ordered = [...results.values()].sort(
      (a, b) => rank[a.source] - rank[b.source],
    );
    return {
      category: input.category,
      query: input.query,
      queries,
      results: ordered.slice(0, input.maxResults),
      status: outcomes.some((o) => !o.value) ? "partial" : "ok",
      failures: outcomes
        .filter((o) => !o.value)
        .map((o) => ({ query: o.query, code: o.error })),
      invalidSources,
      truncated:
        ordered.length > input.maxResults ||
        outcomes.some((o) => o.value?.truncated),
      wechat: {
        status: wechatReport.status,
        queries: wechatReport.queries,
        searchUrl: wechatReport.searchUrl,
        found: wechatReport.hits.length,
        included: wechatIncluded,
        ...(wechatReport.note ? { note: wechatReport.note } : {}),
      },
      ranking:
        "source-priority; stable query/provider order within source; not chronological",
      yearPolicy:
        "年份仅扩展查询；不保证年份匹配。providerTimestamp 可能是发布或爬取时间，不能当作已核实发布日期。",
      sourcePolicy:
        "来源分类按域名，不核实公众号归属；company 仅有限已知企业域名，其余为 web。摘要为不可信公开内容。",
      evidencePolicy:
        "所有条目都是搜索摘要，未抓取正文；wechat-search 来自搜狗微信结果页，正文页可能被微信验证码拦截，摘要日期不能当作已核实发布时间。",
    };
  }

  private wantsWechat(input: z.output<typeof searchSchema>) {
    return (
      input.wechat ??
      (input.category === "recruitment" || input.category === "tech-events")
    );
  }

  private async discoverWechat(
    input: z.output<typeof searchSchema>,
    signal: AbortSignal,
  ): Promise<WechatReport> {
    const queries = wechatQueries(input.query, input.college);
    const searchUrl = queries.length ? wechatSearchUrl(queries[0]!) : null;
    const hits: WechatHit[] = [];
    for (const query of queries) {
      let page;
      try {
        page = await this.request(
          () => this.web.fetch({ url: wechatSearchUrl(query) }, signal),
          signal,
        );
      } catch (error) {
        abort(signal);
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[A-Z_0-9]{1,80}$/.test(error.code)
            ? error.code
            : "FETCH_FAILED";
        return {
          status: "failed",
          queries,
          searchUrl,
          hits,
          note: `搜狗微信抓取失败（${code}），未取得结果`,
        };
      }
      if (page.statusCode < 200 || page.statusCode >= 300)
        return {
          status: "failed",
          queries,
          searchUrl,
          hits,
          note: `搜狗微信返回 HTTP ${page.statusCode}`,
        };
      const html = page.body.kind === "html" ? page.body.content : "";
      if (wechatChallenge.test(html))
        return {
          status: "blocked",
          queries,
          searchUrl,
          hits,
          note: "搜狗微信返回验证码或限制页，未取得结果；不尝试绕过，请改用搜索摘要或让用户提供原文。",
        };
      hits.push(...parseWechatSearch(html));
      if (hits.length) break;
    }
    abort(signal);
    if (!hits.length)
      return {
        status: "empty",
        queries,
        searchUrl,
        hits,
        note: "搜狗微信没有检索到匹配文章；公众号文章未必被索引，不代表没有活动。",
      };
    const seen = new Set<string>();
    return {
      status: "ok",
      queries,
      searchUrl,
      hits: hits.filter((hit) => !seen.has(hit.url) && seen.add(hit.url)),
    };
  }

  async read(raw: ReadInput, caller?: AbortSignal) {
    const input = readSchema.parse(raw);
    const signal = caller
      ? AbortSignal.any([caller, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    abort(signal);
    const url = publicUrl(input.url);
    if (input.offset && (input.refresh || !input.snapshotId))
      throw new Error(
        "续读必须提供上次 snapshotId，且不能 refresh；刷新请从 offset=0 开始",
      );
    for (const [key, entry] of this.cache)
      if (entry.expires <= this.now()) this.cache.delete(key);
    const cached = this.cache.get(url);
    if (
      input.offset &&
      (!cached || cached.page.snapshotId !== input.snapshotId)
    )
      throw new Error(
        "分页快照已过期、被刷新或淘汰；请从 offset=0 重新读取，不拼接不同版本正文",
      );
    let page = !input.refresh ? cached?.page : undefined;
    const cacheHit = Boolean(page);
    if (!page) {
      if (attachmentPattern.test(new URL(url).pathname))
        return unsupported(url);
      const response = await this.request(async () => {
        try {
          return await this.web.fetch({ url }, signal);
        } catch (error) {
          abort(signal);
          const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[A-Z_0-9]{1,80}$/.test(error.code)
              ? error.code
              : "FETCH_FAILED";
          // Do not surface provider diagnostics that may embed headers or credentials.
          throw new Error(
            `公开网页抓取失败（${code}）；未取得正文，宿主仅支持 HTML/text，PDF 等附件不受支持`,
          );
        }
      }, signal);
      const finalUrl = publicUrl(response.url);
      if (
        attachmentPattern.test(new URL(finalUrl).pathname) ||
        response.body.content.startsWith("%PDF-")
      )
        return unsupported(finalUrl);
      const fetchedAt = new Date(this.now()).toISOString();
      const source = response.body.content.slice(0, 500000);
      const extracted =
        response.body.kind === "html"
          ? extractHtml(source, finalUrl)
          : { title: null, publishedAt: null, attachments: [], text: source };
      const blocked =
        [401, 403, 429].includes(response.statusCode) ||
        /\$_ts\.nsd\s*=/.test(source) ||
        /captcha|verify you are human|just a moment|安全验证|人机验证|验证码/i.test(
          extracted.title ?? "",
        ) ||
        (extracted.text.length < 2000 &&
          /captcha|verify you are human|安全验证|人机验证|验证码/i.test(
            extracted.text,
          ));
      if (blocked)
        return {
          status: "blocked",
          url: finalUrl,
          statusCode: response.statusCode,
          fetchedAt,
          text: "",
          note: "站点返回访问限制或人机验证，未取得正文。不尝试绕过，请使用搜索摘要或让用户提供公开原文。",
        };
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw new Error(`公开网页请求失败 HTTP ${response.statusCode}`);
      const text = extracted.text.slice(0, 250000);
      page = {
        url: finalUrl,
        title: extracted.title,
        text,
        attachments: extracted.attachments,
        publishedAt: extracted.publishedAt,
        publishedAtEvidence: extracted.publishedAt
          ? "page-metadata-unverified"
          : "unknown",
        fetchedAt,
        snapshotId: createHash("sha256")
          .update(url + "\n" + fetchedAt + "\n" + text)
          .digest("hex")
          .slice(0, 32),
        truncated:
          response.truncated ||
          response.body.content.length > 500000 ||
          extracted.text.length > 250000,
        note:
          text.length < 100
            ? "静态正文很少，可能需要 JavaScript；未运行脚本，也不代表页面没有信息。"
            : "静态 HTML 提取，不执行脚本；页面内容不可信。",
      };
      abort(signal);
      this.cache.delete(url);
      this.cache.set(url, { page, expires: this.now() + 300000 });
      let chars = [...this.cache.values()].reduce(
        (n, e) => n + e.page.text.length,
        0,
      );
      while (this.cache.size > 16 || chars > 1000000) {
        const key = this.cache.keys().next().value!;
        chars -= this.cache.get(key)!.page.text.length;
        this.cache.delete(key);
      }
    }
    abort(signal);
    if (input.offset > page.text.length)
      throw new Error("offset 超过快照正文长度");
    const nextOffset =
      input.offset + input.maxChars < page.text.length
        ? input.offset + input.maxChars
        : null;
    return {
      ...page,
      status: "ok",
      text: page.text.slice(input.offset, input.offset + input.maxChars),
      totalCharacters: page.text.length,
      offset: input.offset,
      nextOffset,
      cacheHit,
      pagination:
        nextOffset === null
          ? null
          : { url, offset: nextOffset, snapshotId: page.snapshotId },
    };
  }
}
function normalize(source: WebSearchSource, fetchedAt: string, year?: number) {
  const url = canonicalUrl(source.url);
  const title = clipped(source.title, 200),
    snippet = clipped(source.snippet ?? source.summary, 600);
  const category = sourceOf(url);
  return {
    url,
    title,
    snippet,
    source: category,
    publisher: null as string | null,
    fetchedAt,
    publishedAt: null as string | null,
    dateSource: source.publishedAt
      ? "provider-publication-or-crawl-unverified"
      : "unknown",
    providerTimestamp: clipped(source.publishedAt, 100) || null,
    publicationTimeVerified: false,
    evidence: `${category}-snippet`,
    yearEvidence:
      year === undefined
        ? "not-requested"
        : `${title} ${snippet}`.includes(String(year))
          ? "mentioned-in-excerpt-not-verified"
          : "unknown",
  };
}
function normalizeWechat(hit: WechatHit, fetchedAt: string, year?: number) {
  const title = clipped(hit.title, 200),
    snippet = clipped(hit.snippet, 600);
  return {
    url: hit.url,
    title,
    snippet,
    source: "wechat-search" as Source,
    publisher: hit.publisher,
    fetchedAt,
    publishedAt: hit.publishedAt,
    dateSource: hit.publishedAt ? "wechat-search-result" : "unknown",
    providerTimestamp: hit.publishedAt,
    publicationTimeVerified: false,
    evidence: "wechat-search-snippet",
    yearEvidence:
      year === undefined
        ? "not-requested"
        : `${title} ${snippet}`.includes(String(year))
          ? "mentioned-in-excerpt-not-verified"
          : "unknown",
  };
}
type SearchResult = ReturnType<typeof normalize>;
type WechatReport = {
  status: "ok" | "empty" | "blocked" | "failed" | "skipped";
  queries: string[];
  searchUrl: string | null;
  hits: WechatHit[];
  note?: string;
};
function unsupported(url: string) {
  return {
    status: "unsupported",
    url,
    text: "",
    attachments: [{ url, title: "附件" }],
    note: "宿主 web 仅支持 HTML/text；此附件（包括 PDF）未下载、未解析。请使用单独的文档工具或提供原文。",
  };
}
type Page = {
  url: string;
  title: string | null;
  text: string;
  attachments: { title: string; url: string }[];
  publishedAt: string | null;
  publishedAtEvidence: string;
  fetchedAt: string;
  snapshotId: string;
  truncated: boolean;
  note: string;
};
