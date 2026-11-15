import type { Context } from "@deepseek-ai/cordis";
import {
  credentialRef,
  type CredentialProvider,
} from "@deepseek-ai/dsh-credentials";
import {
  WebError,
  type WebSearchProvider,
  type WebSearchSource,
} from "@deepseek-ai/dsh-web";
import { z } from "zod";
import { publicUrl } from "./html.js";

const ref = z
  .string()
  .regex(
    /^MYH_RESEARCH_[A-Z0-9_]+$/,
    "搜索密钥引用必须使用独立 MYH_RESEARCH_ 前缀",
  );
export const researchProvidersSchema = z
  .object({
    brave: z.object({ apiKeyRef: ref }).strict().optional(),
    google: z
      .object({ apiKeyRef: ref, cx: z.string().trim().min(1).max(256) })
      .strict()
      .optional(),
    searxng: z
      .object({ url: z.string().max(4096), bearerTokenRef: ref.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type ResearchProvidersConfig = z.input<typeof researchProvidersSchema>;
type Kind = "brave" | "google" | "searxng";
const fail = (message: string, code: string): never => {
  throw new WebError(message, code);
};
const itemSchema = z.object({
  url: z.string().optional(),
  title: z.string().nullish(),
  snippets: z.array(z.string()).optional(),
});
const braveSchema = z.object({
  grounding: z.object({
    generic: z.array(itemSchema).optional(),
    map: z.array(itemSchema).optional(),
    poi: itemSchema.nullish(),
  }),
});
const googleSchema = z.object({
  items: z
    .array(
      z.object({
        link: z.string(),
        title: z.string().optional(),
        snippet: z.string().optional(),
      }),
    )
    .optional(),
  searchInformation: z.object({ totalResults: z.string() }).optional(),
});
const searxSchema = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
    }),
  ),
  unresponsive_engines: z.array(z.unknown()).optional(),
});

/** Explicit user-owned search configuration only. Never reads campus credential records or old project settings. */
export function createResearchSearchProviders(
  raw: ResearchProvidersConfig,
  credentials: Pick<CredentialProvider, "resolve">,
  transport: typeof fetch = globalThis.fetch,
): WebSearchProvider[] {
  const config = researchProvidersSchema.parse(raw);
  if (config.searxng) {
    const endpoint = new URL(publicUrl(config.searxng.url));
    if (endpoint.protocol !== "https:" || endpoint.search)
      throw new Error("SearXNG 需无查询参数的公开 HTTPS JSON 搜索端点");
    config.searxng.url = endpoint.href;
  }
  return (["brave", "google", "searxng"] as const).map((kind) => {
    const selected = config[kind];
    const keyRef =
      kind === "searxng"
        ? config.searxng?.bearerTokenRef
        : kind === "brave"
          ? config.brave?.apiKeyRef
          : config.google?.apiKeyRef;
    const resolve = async () => {
      if (!selected) return undefined;
      if (!keyRef) return "";
      try {
        return (await credentials.resolve(credentialRef(keyRef)))?.value;
      } catch {
        return fail(`${kind} 搜索凭据解析失败`, "MYH_SEARCH_CREDENTIAL_FAILED");
      }
    };
    return {
      id: `myh-${kind}`,
      title: `明远湖光 ${kind}`,
      description: {
        en: "Explicit user-owned public search; configure research provider credentials, then select this provider in DSH. No fallback to another paid source.",
        zh: "配置独立公开搜索密钥后，在宿主选择本来源；失败不会静默切换其他收费来源。",
      },
      available: () => Boolean(selected),
      ready: async () => (await resolve()) !== undefined,
      async search(request, caller) {
        const query = z.string().trim().min(1).max(2000).parse(request.query);
        const count =
          request.maxResults === undefined
            ? 10
            : z.number().int().min(1).max(100).parse(request.maxResults);
        const signal = caller
          ? AbortSignal.any([caller, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000);
        signal.throwIfAborted();
        if (!selected)
          return fail(
            `请先配置 ${kind} 公开搜索来源`,
            "MYH_SEARCH_NOT_CONFIGURED",
          );
        const key = await resolve();
        signal.throwIfAborted();
        if (key === undefined)
          return fail(
            `请设置 ${kind} 的独立搜索凭据引用`,
            "MYH_SEARCH_CREDENTIAL_MISSING",
          );
        const headers: Record<string, string> = { accept: "application/json" };
        let url: URL;
        if (kind === "brave") {
          url = new URL("https://api.search.brave.com/res/v1/llm/context");
          url.searchParams.set("q", query);
          url.searchParams.set("count", String(Math.min(count, 20)));
          headers["x-subscription-token"] = key;
        } else if (kind === "google") {
          url = new URL("https://www.googleapis.com/customsearch/v1");
          url.searchParams.set("q", query);
          url.searchParams.set("num", String(Math.min(count, 10)));
          url.searchParams.set("key", key);
          url.searchParams.set("cx", config.google!.cx);
        } else {
          url = new URL(config.searxng!.url);
          url.searchParams.set("q", query);
          url.searchParams.set("format", "json");
          if (key) headers.authorization = `Bearer ${key}`;
        }
        let response: Response;
        try {
          response = await transport(url, {
            headers,
            signal,
            redirect: "error",
            credentials: "omit",
          });
        } catch {
          signal.throwIfAborted();
          return fail(
            `${kind} 网络请求失败（不切换其他来源）`,
            "MYH_SEARCH_NETWORK_FAILED",
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          return fail(
            `${kind} 搜索失败 HTTP ${response.status}`,
            "MYH_SEARCH_HTTP_FAILED",
          );
        }
        const reader = response.body?.getReader();
        if (!reader)
          return fail(`${kind} 响应为空`, "MYH_SEARCH_INVALID_RESPONSE");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2 * 1024 * 1024)
              return fail(`${kind} JSON 超过2MiB限制`, "MYH_SEARCH_SIZE_LIMIT");
            chunks.push(value);
          }
          signal.throwIfAborted();
          const payload: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          const sources = parseSources(kind, payload);
          return {
            sources: sources.slice(0, count),
            truncated: sources.length > count,
          };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof WebError) throw error;
          return fail(
            `${kind} 返回无效 JSON/搜索结构`,
            "MYH_SEARCH_INVALID_RESPONSE",
          );
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
    };
  });
}

function parseSources(kind: Kind, payload: unknown): WebSearchSource[] {
  let sources: WebSearchSource[];
  if (kind === "brave") {
    const { grounding: g } = braveSchema.parse(payload);
    sources = [
      ...(g.generic ?? []),
      ...(g.map ?? []),
      ...(g.poi ? [g.poi] : []),
    ]
      .filter((v) => v.url)
      .map((v) => ({
        url: v.url!,
        title: v.title ?? undefined,
        snippet: v.snippets?.join(" "),
      }));
  } else if (kind === "google") {
    const value = googleSchema.parse(payload);
    if (!value.items && !value.searchInformation)
      return fail("Google 未返回搜索结果结构", "MYH_SEARCH_INVALID_RESPONSE");
    sources = (value.items ?? []).map((v) => ({
      url: v.link,
      title: v.title,
      snippet: v.snippet,
    }));
  } else {
    const value = searxSchema.parse(payload);
    // Do not hide engine outages behind a seemingly complete result set.
    if (value.unresponsive_engines?.length)
      return fail(
        "SearXNG 部分或全部引擎无响应，结果不完整",
        "MYH_SEARCH_ENGINE_FAILED",
      );
    sources = value.results.map((v) => ({
      url: v.url,
      title: v.title,
      snippet: v.content,
    }));
  }
  return sources.slice(0, 100).flatMap((source) => {
    try {
      return [
        {
          url: publicUrl(source.url),
          title: source.title?.slice(0, 300),
          snippet: source.snippet?.slice(0, 2000),
        },
      ];
    } catch {
      return [];
    }
  });
}

export function registerResearchSearchProviders(
  ctx: Context,
  config: ResearchProvidersConfig,
) {
  return createResearchSearchProviders(config, ctx.credentials).map(
    (provider) => ctx.web.registerSearchProvider(provider),
  );
}
