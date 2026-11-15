import { describe, expect, it, vi } from "vitest";
import { ResearchService } from "../src/research/service.js";
import { extractHtml } from "../src/research/html.js";
import { registerResearchTools } from "../src/research/index.js";
import type { Context } from "@deepseek-ai/cordis";
import type { WebFetchResult, WebSearchResult } from "@deepseek-ai/dsh-web";

const empty = (): WebSearchResult => ({ sources: [], truncated: false });
const page = (content: string): WebFetchResult => ({
  url: "https://www.scu.edu.cn/news",
  statusCode: 200,
  body: { kind: "html", content },
  truncated: false,
});
const mocks = () => ({
  search: vi.fn(
    async (
      _request: { query: string; maxResults?: number },
      _signal?: AbortSignal,
    ) => empty(),
  ),
  fetch: vi.fn(async (_request: { url: string }, _signal?: AbortSignal) =>
    page("<article>公开正文</article>"),
  ),
});

describe("campus public research", () => {
  it("registers independent names without accessing campus clients or credentials", () => {
    const names: string[] = [];
    const context = {
      web: mocks(),
      tools: { register: (tool: { name: string }) => names.push(tool.name) },
    };
    for (const key of ["campus", "credentials", "client"])
      Object.defineProperty(context, key, {
        get() {
          throw new Error(`private access: ${key}`);
        },
      });
    registerResearchTools(context as unknown as Context);
    expect(names).toEqual(["scu_search", "scu_read_webpage"]);
  });
  it("expands bounded searches, deduplicates, ranks stable sources without inventing dates", async () => {
    const web = mocks();
    web.search.mockResolvedValue({
      sources: [
        { url: "https://example.com/a", title: "2027招聘" },
        { url: "https://mp.weixin.qq.com/s?__biz=abc&mid=1", title: "公众号" },
        {
          url: "https://cs.scu.edu.cn/a?utm_source=x#top",
          title: "学院2026招生",
          publishedAt: "2025-01-01",
        },
        { url: "https://cs.scu.edu.cn/a", title: "重复" },
        { url: "https://career.huawei.com/a", title: "企业" },
      ],
      truncated: false,
    });
    const result = await new ResearchService(web).search({
      query: "计算机",
      category: "recruitment",
      year: 2026,
      college: "计算机学院",
    });
    expect(web.search).toHaveBeenCalledTimes(4);
    expect(result.results.map((r) => r.source)).toEqual([
      "official",
      "wechat",
      "company",
      "web",
    ]);
    expect(result.results[0]).toMatchObject({
      publishedAt: null,
      providerTimestamp: "2025-01-01",
      yearEvidence: "mentioned-in-excerpt-not-verified",
      publicationTimeVerified: false,
    });
    expect(result.results[3].yearEvidence).toBe("unknown");
    for (const [request, signal] of web.search.mock.calls as unknown as [
      Record<string, unknown>,
      AbortSignal,
    ][]) {
      expect(Object.keys(request).sort()).toEqual(["maxResults", "query"]);
      expect(request.query).toContain("2026");
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("distinguishes all failed, partial failure and successful zero results; redacts provider messages", async () => {
    const web = mocks();
    web.search.mockRejectedValue(new Error("secret-token=do-not-leak"));
    await expect(
      new ResearchService(web).search({ query: "招聘" }),
    ).rejects.toThrow("不是零条结果");
    web.search.mockResolvedValueOnce(empty());
    const partial = await new ResearchService(web).search({ query: "招聘" });
    expect(partial.status).toBe("partial");
    expect(partial.failures).toHaveLength(3);
    expect(JSON.stringify(partial)).not.toContain("do-not-leak");
    web.search.mockResolvedValue(empty());
    expect(
      (await new ResearchService(web).search({ query: "招聘" })).status,
    ).toBe("ok");
  });

  it("limits concurrent requests across calls and cancels queued work", async () => {
    const web = mocks();
    let active = 0,
      maximum = 0;
    web.search.mockImplementation(
      async (_request?: unknown, signal?: AbortSignal) => {
        active++;
        maximum = Math.max(maximum, active);
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
          return empty();
        } finally {
          active--;
        }
      },
    );
    const service = new ResearchService(web);
    await Promise.all([
      service.search({ query: "a" }),
      service.search({ query: "b" }),
    ]);
    expect(maximum).toBe(2);
    const controller = new AbortController();
    const pending = service.search({ query: "cancel" }, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    const count = web.search.mock.calls.length;
    await expect(
      service.search({ query: "never" }, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(web.search).toHaveBeenCalledTimes(count);
  });

  it("extracts markdown and relative attachments, excluding scripts and unsafe links", () => {
    const result = extractHtml(
      '<title>通知</title><script>secret()</script><nav>导航</nav><article><h1>竞赛</h1><p>正文 &amp; 内容</p><a href="/files/rules.pdf">附件规则</a><a href="javascript:evil()">bad</a><a href="/auth?token=secret">private</a></article>',
      "https://scu.edu.cn/news",
    );
    expect(result.text).toContain("# 竞赛");
    expect(result.text).toContain("正文 & 内容");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("导航");
    expect(result.attachments).toEqual([
      { title: "附件规则", url: "https://scu.edu.cn/files/rules.pdf" },
    ]);
  });

  it("keeps snapshot pagination consistent, refreshes and expires explicitly", async () => {
    const web = mocks();
    let now = 1000000;
    web.fetch.mockResolvedValue(page("<article>abcdefghij</article>"));
    const service = new ResearchService(web, () => now);
    const first = await service.read({
      url: "https://scu.edu.cn/news",
      maxChars: 4,
    });
    expect(first.status).toBe("ok");
    if (!("snapshotId" in first)) throw new Error("missing snapshot");
    const second = await service.read({
      url: "https://scu.edu.cn/news",
      offset: 4,
      maxChars: 4,
      snapshotId: first.snapshotId,
    });
    expect(second.text).toBe("efgh");
    expect(web.fetch).toHaveBeenCalledTimes(1);
    await expect(
      service.read({ url: "https://scu.edu.cn/news", offset: 4 }),
    ).rejects.toThrow("snapshotId");
    web.fetch.mockResolvedValue(page("<article>new content</article>"));
    now++;
    await service.read({ url: "https://scu.edu.cn/news", refresh: true });
    await expect(
      service.read({
        url: "https://scu.edu.cn/news",
        offset: 4,
        snapshotId: first.snapshotId,
      }),
    ).rejects.toThrow("快照");
    now += 300001;
    await expect(
      service.read({
        url: "https://scu.edu.cn/news",
        offset: 4,
        snapshotId: first.snapshotId,
      }),
    ).rejects.toThrow("快照");
  });

  it("bounds cache entries and truncation, and rejects evicted continuation", async () => {
    const web = mocks();
    const service = new ResearchService(web);
    web.fetch.mockResolvedValue(
      page(`<article>${"x".repeat(260000)}</article>`),
    );
    const first = await service.read({
      url: "https://scu.edu.cn/0",
      maxChars: 5,
    });
    if (!("snapshotId" in first)) throw new Error("missing snapshot");
    expect(first.truncated).toBe(true);
    expect(first.totalCharacters).toBe(250000);
    for (let n = 1; n <= 5; n++)
      await service.read({ url: `https://scu.edu.cn/${n}` });
    await expect(
      service.read({
        url: "https://scu.edu.cn/0",
        offset: 5,
        snapshotId: first.snapshotId,
      }),
    ).rejects.toThrow("快照");
  });

  it("never passes campus credentials, rejects private URLs, and does not pretend to parse PDFs", async () => {
    const web = mocks();
    const service = new ResearchService(web);
    for (const url of [
      "https://user:pass@scu.edu.cn/a",
      "https://scu.edu.cn/a?token=secret",
      "https://scu.edu.cn/login",
      "http://127.0.0.1/x",
      "http://[::1]/x",
      "file:///secret",
    ]) {
      await expect(service.read({ url })).rejects.toThrow();
    }
    expect(web.fetch).not.toHaveBeenCalled();
    const pdf = await service.read({ url: "https://scu.edu.cn/rules.pdf" });
    expect(pdf.status).toBe("unsupported");
    expect(pdf.text).toBe("");
    expect(web.fetch).not.toHaveBeenCalled();
    await service.read({ url: "https://scu.edu.cn/news" });
    expect(web.fetch.mock.calls[0]?.[0]).toEqual({
      url: "https://scu.edu.cn/news",
    });
    expect(Object.keys(web.fetch.mock.calls[0]?.[0] ?? {})).toEqual(["url"]);
  });

  it("cancels fetch without saving an incomplete snapshot", async () => {
    const web = mocks();
    const service = new ResearchService(web);
    web.fetch.mockImplementation(async (_request, signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return page("not reached");
    });
    const controller = new AbortController();
    const pending = service.read(
      { url: "https://scu.edu.cn/news" },
      controller.signal,
    );
    controller.abort(new Error("stop read"));
    await expect(pending).rejects.toThrow("stop read");
    web.fetch.mockResolvedValue(page("<p>retry</p>"));
    expect((await service.read({ url: "https://scu.edu.cn/news" })).text).toBe(
      "retry",
    );
    expect(web.fetch).toHaveBeenCalledTimes(2);
  });

  it("reports anti-bot, HTTP and unsupported fetch errors, does not cache failures", async () => {
    const web = mocks();
    const service = new ResearchService(web);
    const url = "https://scu.edu.cn/news";
    web.fetch.mockResolvedValue(page("<title>人机验证</title><p>验证码</p>"));
    expect((await service.read({ url })).status).toBe("blocked");
    web.fetch.mockResolvedValue({ ...page("missing"), statusCode: 404 });
    await expect(service.read({ url })).rejects.toThrow("404");
    web.fetch.mockRejectedValue(
      Object.assign(new Error("private diagnostics"), {
        code: "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE",
      }),
    );
    await expect(service.read({ url })).rejects.toThrow("UNSUPPORTED");
    expect(web.fetch).toHaveBeenCalledTimes(3);
  });
});
