import { parse, type HTMLElement } from "node-html-parser";

/** 搜狗微信搜索只在结果页提供标题、摘要与公众号名；文章正文页由微信加验证码，不在此处尝试绕过。 */
export const wechatSearchOrigin = "https://weixin.sogou.com";
export const wechatChallenge =
  /antispider|请输入验证码|此验证码用于确认|VerifyCode|网络不给力/i;
const maxHits = 10;

export type WechatHit = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publisher: string | null;
  readonly publishedAt: string | null;
};

export function wechatSearchUrl(query: string): string {
  const url = new URL("/weixin", wechatSearchOrigin);
  url.searchParams.set("type", "2");
  url.searchParams.set("ie", "utf8");
  url.searchParams.set("query", query);
  return url.href;
}

/**
 * 结果是搜狗的中转链接，带搜索会话 token；它不是用户凭据，但也不适合用 publicUrl 放行，
 * 所以单独校验协议与主机白名单。该链接可能被搜狗反爬拦截，调用方应把它当来源线索而非可读正文。
 */
function wechatHitUrl(raw: string): string | null {
  const href = raw.trim();
  if (!href || href === "#" || /^(?:javascript|mailto|data):/i.test(href))
    return null;
  let url: URL;
  try {
    url = new URL(href, wechatSearchOrigin);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    return null;
  if (
    url.hostname !== "weixin.sogou.com" &&
    url.hostname !== "mp.weixin.qq.com"
  )
    return null;
  // 空 href 会被解析成站点根，这不是文章链接。
  if (url.pathname === "/") return null;
  url.hash = "";
  return url.href;
}

function stamp(value: string | null | undefined): string | null {
  if (!value || !/^\d{9,11}$/.test(value.trim())) return null;
  const date = new Date(Number(value.trim()) * 1000);
  const year = date.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? date.toISOString() : null;
}

function publishedAtOf(box: HTMLElement): string | null {
  const holder = box.querySelector("[t]") ?? box.parentNode;
  const attribute =
    holder instanceof Object && "getAttribute" in holder
      ? ((holder as HTMLElement).getAttribute("t") ?? null)
      : null;
  const scripted = /timeConvert\('(\d{9,11})'\)/.exec(box.toString())?.[1];
  return stamp(attribute) ?? stamp(scripted);
}

/** 静态解析搜狗微信结果页；不执行脚本、不跟随跳转。残缺条目直接丢弃。 */
export function parseWechatSearch(html: string): WechatHit[] {
  const root = parse(html);
  const boxes = root.querySelectorAll(".txt-box");
  const blocks = boxes.length
    ? boxes
    : root.querySelectorAll("li").filter((node) => node.querySelector("h3 a"));
  const hits: WechatHit[] = [];
  const seen = new Set<string>();
  for (const box of blocks) {
    const anchor = box.querySelector("h3 a") ?? box.querySelector("a[href]");
    const title = anchor?.text.replace(/\s+/g, " ").trim() ?? "";
    const url = wechatHitUrl(anchor?.getAttribute("href") ?? "");
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    hits.push({
      title: title.slice(0, 300),
      url,
      snippet: (box.querySelector(".txt-info")?.text ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600),
      publisher:
        (
          box.querySelector("a.account")?.text ??
          box.querySelector(".s-p a")?.text ??
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100) || null,
      publishedAt: publishedAtOf(box),
    });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

/** 学院公众号名与官网不同，命中标题往往只出现在公众号里；只收录已确认存在的账号。 */
const channels = [
  { match: /计算机|软件/, channel: "川大计算机软件就业" },
  { match: /电子|信息/, channel: "川大电子信息" },
];

export function channelOf(college: string | undefined): string | null {
  if (!college) return null;
  return channels.find(({ match }) => match.test(college))?.channel ?? null;
}

export function wechatQueries(
  query: string,
  college: string | undefined,
): string[] {
  const channel = channelOf(college);
  const base = [query, college].filter(Boolean).join(" ");
  const list = [
    ...(channel ? [`${query} ${channel}`] : []),
    `${base} 活动预告`,
    base,
  ];
  return [...new Set(list)].slice(0, 2);
}
