import { describe, expect, it, vi } from "vitest";
import {
  ResearchService,
  expandQueries,
  searchSchema,
} from "../src/research/service.js";
import {
  channelOf,
  parseWechatSearch,
  wechatQueries,
  wechatSearchUrl,
} from "../src/research/wechat.js";
import type { WebFetchResult, WebSearchResult } from "@deepseek-ai/dsh-web";

const empty = (): WebSearchResult => ({ sources: [], truncated: false });
const sogouPage = (body: string): WebFetchResult => ({
  url: wechatSearchUrl("米哈游"),
  statusCode: 200,
  body: { kind: "html", content: body },
  truncated: false,
});
const hit = (
  title: string,
  snippet: string,
  account: string,
  stamp = "1794408855",
) => `
<li id="sogou_vr_11002601_box_0">
  <div class="txt-box">
    <h3><a href="/link?url=abc&amp;type=2&amp;query=%E7%B1%B3%E5%93%88%E6%B8%B8" target="_blank">${title}</a></h3>
    <p class="txt-info">${snippet}</p>
    <div class="s-p" t="${stamp}"><a class="account" href="/mp?x">${account}</a></div>
  </div>
</li>`;
const mocks = () => ({
  search: vi.fn(async () => empty()),
  fetch: vi.fn(async () => sogouPage("")),
});

describe("sogou wechat discovery", () => {
  it("parses title, snippet, publisher and date; skips broken or foreign links", () => {
    const html = `<ul class="news-list">
      ${hit(
        "11月12日川大专场宣讲会｜双选会｜<em>11月20日米哈游</em>活动信息一览",
        "米哈游招聘宣讲 宣讲时间 2026-11-20 14:00 望江校区",
        "川大计算机软件就业",
      )}
      <li><div class="txt-box"><h3><a href="">没有链接</a></h3></div></li>
      <li><div class="txt-box"><h3><a href="javascript:alert(1)">脚本链接</a></h3></div></li>
      <li><div class="txt-box"><h3><a href="https://evil.example/x">站外链接</a></h3></div></li>
    </ul>`;
    const hits = parseWechatSearch(html);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "11月12日川大专场宣讲会｜双选会｜11月20日米哈游活动信息一览",
      snippet: "米哈游招聘宣讲 宣讲时间 2026-11-20 14:00 望江校区",
      publisher: "川大计算机软件就业",
    });
    expect(hits[0]!.url.startsWith("https://weixin.sogou.com/link?")).toBe(
      true,
    );
    expect(hits[0]!.publishedAt).toBe(
      new Date(1794408855 * 1000).toISOString(),
    );
  });

  it("builds bounded queries and maps verified college channels", () => {
    expect(channelOf("计算机学院（软件学院）")).toBe("川大计算机软件就业");
    expect(channelOf("数学学院")).toBeNull();
    expect(wechatQueries("米哈游", "计算机学院")).toEqual([
      "米哈游 川大计算机软件就业",
      "米哈游 计算机学院 活动预告",
    ]);
    expect(wechatQueries("米哈游", undefined)).toEqual([
      "米哈游 活动预告",
      "米哈游",
    ]);
  });

  it("expands recruitment queries with activity wording and the current month", () => {
    const input = searchSchema.parse({
      query: "米哈游",
      category: "recruitment",
    });
    const queries = expandQueries(input, Date.UTC(2026, 10, 15, 4, 0, 0));
    expect(queries).toHaveLength(4);
    expect(queries[3]).toContain("活动预告");
    expect(queries[3]).toContain("11月");
    expect(expandQueries(input, Date.now())[0]).toContain("site:scu.edu.cn");
  });

  it("merges wechat hits below official sources and reports the discovery layer", async () => {
    const web = mocks();
    web.search.mockResolvedValue({
      sources: [
        { url: "https://cs.scu.edu.cn/notice/1", title: "学院宣讲通知" },
        { url: "https://example.com/news", title: "转载新闻" },
      ],
      truncated: false,
    });
    web.fetch.mockResolvedValue(
      sogouPage(
        `<ul>${hit(
          "11月12日川大专场宣讲会｜双选会｜米哈游活动信息一览",
          "米哈游招聘宣讲 2026-11-20 14:00 望江校区就业指导中心",
          "川大计算机软件就业",
        )}</ul>`,
      ),
    );
    const result = await new ResearchService(web).search({
      query: "米哈游",
      category: "recruitment",
      college: "计算机学院",
    });
    expect(result.results.map((r) => r.source)).toEqual([
      "official",
      "wechat-search",
      "web",
    ]);
    expect(result.results[1]).toMatchObject({
      title: "11月12日川大专场宣讲会｜双选会｜米哈游活动信息一览",
      publisher: "川大计算机软件就业",
      evidence: "wechat-search-snippet",
      publicationTimeVerified: false,
    });
    expect(result.wechat).toMatchObject({
      status: "ok",
      found: 1,
      included: 1,
    });
    expect(JSON.stringify(result.wechat)).toContain("weixin.sogou.com");
    expect(result.evidencePolicy).toContain("搜索摘要");
    for (const [request] of web.fetch.mock.calls as unknown as [
      { url: string },
    ][]) {
      expect(Object.keys(request)).toEqual(["url"]);
      expect(request.url).toContain("weixin.sogou.com/weixin?");
    }
  });

  it("keeps the search usable when sogou shows a captcha or fails", async () => {
    const web = mocks();
    web.search.mockResolvedValue({
      sources: [{ url: "https://cs.scu.edu.cn/notice/1", title: "通知" }],
      truncated: false,
    });
    web.fetch.mockResolvedValue(
      sogouPage(
        "<html><title>搜狗搜索</title>IP：1.2.3.4 此验证码用于确认这些请求是您的正常行为而不是自动程序发出的</html>",
      ),
    );
    const blocked = await new ResearchService(web).search({
      query: "米哈游",
      category: "recruitment",
    });
    expect(blocked.status).toBe("ok");
    expect(blocked.results.map((r) => r.source)).toEqual(["official"]);
    expect(blocked.wechat).toMatchObject({ status: "blocked", found: 0 });
    expect((blocked.wechat as { note?: string }).note).toContain("验证码");

    web.fetch.mockRejectedValue(
      Object.assign(new Error("private diagnostics"), {
        code: "WEB_FETCH_FAILED",
      }),
    );
    const failed = await new ResearchService(web).search({
      query: "米哈游",
      category: "recruitment",
    });
    expect(failed.wechat).toMatchObject({ status: "failed", found: 0 });
    expect(JSON.stringify(failed)).not.toContain("private diagnostics");
    expect((failed.wechat as { note?: string }).note).not.toContain(
      "private diagnostics",
    );
  });

  it("runs the discovery layer for recruitment by default and only on request elsewhere", async () => {
    const web = mocks();
    web.search.mockResolvedValue({
      sources: [{ url: "https://example.com/a", title: "A" }],
      truncated: false,
    });
    await new ResearchService(web).search({ query: "米哈游" });
    expect(web.fetch).not.toHaveBeenCalled();

    await new ResearchService(web).search({
      query: "米哈游",
      category: "recruitment",
      wechat: false,
    });
    expect(web.fetch).not.toHaveBeenCalled();

    await new ResearchService(web).search({ query: "米哈游", wechat: true });
    // 两个候选查询都返回空结果页，因此两次抓取后才判定为 empty。
    expect(web.fetch).toHaveBeenCalledTimes(2);
    for (const [request] of web.fetch.mock.calls as unknown as [
      { url: string },
    ][])
      expect(request.url).toContain("weixin.sogou.com/weixin?");

    const result = await new ResearchService(web).search({
      query: "米哈游",
      category: "general",
    });
    expect(result.wechat).toMatchObject({ status: "skipped" });
  });
});
