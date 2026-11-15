import { describe, expect, it, vi } from "vitest";
import { createResearchSearchProviders } from "../src/research/providers.js";

const config = {
  brave: { apiKeyRef: "MYH_RESEARCH_BRAVE" },
  google: { apiKeyRef: "MYH_RESEARCH_GOOGLE", cx: "engine-id" },
  searxng: {
    url: "https://search.example.com/search",
    bearerTokenRef: "MYH_RESEARCH_SEARX",
  },
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

describe("user-owned public search adapters", () => {
  it("registers distinct provider identities and explicitly unconfigured availability", async () => {
    const credentials = { resolve: vi.fn(async () => undefined) };
    const network = vi.fn();
    const providers = createResearchSearchProviders({}, credentials, network);
    expect(providers.map((p) => p.id)).toEqual([
      "myh-brave",
      "myh-google",
      "myh-searxng",
    ]);
    for (const provider of providers) {
      expect(provider.available()).toBe(false);
      expect(await provider.ready?.(undefined)).toBe(false);
      await expect(provider.search({ query: "test" })).rejects.toThrow("配置");
    }
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("matches original Brave context API and only sends explicit independent search key", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ value: "brave-secret", source: "test" })),
    };
    const network = vi.fn(async () =>
      response({
        grounding: {
          generic: [
            {
              url: "https://scu.edu.cn/one",
              title: "通知",
              snippets: ["a", "b"],
            },
          ],
          map: [{ url: "https://scu.edu.cn/two" }],
        },
      }),
    );
    const provider = createResearchSearchProviders(
      config,
      credentials,
      network,
    )[0]!;
    const result = await provider.search({
      query: "四川大学 招聘",
      maxResults: 1,
    });
    expect(result.sources).toEqual([
      { url: "https://scu.edu.cn/one", title: "通知", snippet: "a b" },
    ]);
    expect(result.truncated).toBe(true);
    expect(credentials.resolve).toHaveBeenCalledWith("MYH_RESEARCH_BRAVE");
    const [url, init] = network.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(
      "https://api.search.brave.com/res/v1/llm/context",
    );
    expect(url.searchParams.get("count")).toBe("1");
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      headers: {
        accept: "application/json",
        "x-subscription-token": "brave-secret",
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("uses Google key/cx/q/num and re-resolves keys each operation without leaking errors", async () => {
    const credentials = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce({ value: "one", source: "test" })
        .mockResolvedValueOnce({ value: "two", source: "test" }),
    };
    const network = vi.fn(async () =>
      response({
        items: [{ link: "https://scu.edu.cn/a", title: "a", snippet: "b" }],
      }),
    );
    const provider = createResearchSearchProviders(
      config,
      credentials,
      network,
    )[1]!;
    await provider.search({ query: "q", maxResults: 20 });
    await provider.search({ query: "q" });
    const first = (network.mock.calls[0] as unknown as [URL])[0];
    const second = (network.mock.calls[1] as unknown as [URL])[0];
    expect(first.origin + first.pathname).toBe(
      "https://www.googleapis.com/customsearch/v1",
    );
    expect(Object.fromEntries(first.searchParams)).toEqual({
      q: "q",
      num: "10",
      key: "one",
      cx: "engine-id",
    });
    expect(second.searchParams.get("key")).toBe("two");
  });
  it("supports SearXNG JSON, refuses engine outages, never falls back to another paid source", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ value: "searx-key", source: "test" })),
    };
    const network = vi.fn(async () =>
      response({
        results: [{ url: "https://scu.edu.cn/a", title: "a", content: "body" }],
      }),
    );
    const provider = createResearchSearchProviders(
      config,
      credentials,
      network,
    )[2]!;
    expect((await provider.search({ query: "q" })).sources[0]?.snippet).toBe(
      "body",
    );
    const [url, init] = network.mock.calls[0] as unknown as [URL, RequestInit];
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "q",
      format: "json",
    });
    expect(init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer searx-key",
    });
    network.mockResolvedValue(
      response({ results: [], unresponsive_engines: [["google", "timeout"]] }),
    );
    await expect(provider.search({ query: "q" })).rejects.toThrow("引擎无响应");
    expect(network).toHaveBeenCalledTimes(2);
    expect(
      credentials.resolve.mock.calls.every(
        (args) => (args as unknown as [string])[0] === "MYH_RESEARCH_SEARX",
      ),
    ).toBe(true);
  });
  it("fails closed on missing secrets, malformed JSON, HTTP failure and network diagnostics", async () => {
    const credentials = { resolve: vi.fn().mockResolvedValue(undefined) };
    const network = vi.fn();
    const provider = createResearchSearchProviders(
      config,
      credentials,
      network,
    )[0]!;
    await expect(provider.search({ query: "q" })).rejects.toThrow("凭据");
    expect(network).not.toHaveBeenCalled();
    credentials.resolve.mockResolvedValue({ value: "secret", source: "test" });
    network.mockResolvedValue(response({ wrong: "shape" }));
    await expect(provider.search({ query: "q" })).rejects.toThrow("无效");
    network.mockResolvedValue(new Response("private-body", { status: 401 }));
    await expect(provider.search({ query: "q" })).rejects.toThrow("HTTP 401");
    network.mockRejectedValue(new Error("key=secret"));
    await expect(provider.search({ query: "q" })).rejects.toThrow(
      "网络请求失败",
    );
  });
  it("rejects campus references and credential-bearing endpoints; cancellation issues no request", async () => {
    const credentials = { resolve: vi.fn() };
    const network = vi.fn();
    expect(() =>
      createResearchSearchProviders(
        { brave: { apiKeyRef: "SCU_TOKEN" } },
        credentials,
        network,
      ),
    ).toThrow();
    for (const url of [
      "http://search.example.com",
      "https://user:pass@search.example.com",
      "https://search.example.com/?token=secret",
      "https://127.0.0.1/search",
    ])
      expect(() =>
        createResearchSearchProviders(
          { searxng: { url } },
          credentials,
          network,
        ),
      ).toThrow();
    const provider = createResearchSearchProviders(
      config,
      credentials,
      network,
    )[0]!;
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(provider.search({ query: "q" }, abort.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(network).not.toHaveBeenCalled();
    expect(credentials.resolve).not.toHaveBeenCalled();
  });
  it("limits JSON response bytes rather than parsing oversized responses", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ value: "key", source: "test" })),
    };
    const network = vi.fn(
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    );
    const provider = createResearchSearchProviders(
      config,
      credentials,
      network,
    )[0]!;
    await expect(provider.search({ query: "q" })).rejects.toThrow("2MiB");
  });
});
