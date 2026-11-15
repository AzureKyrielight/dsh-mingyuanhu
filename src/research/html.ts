import { parse, HTMLElement, NodeType, type Node } from "node-html-parser";

export function publicUrl(raw: string, base?: string): string {
  if (raw.length > 4096) throw new Error("URL 超过4096字符限制");
  const url = new URL(raw, base);
  if (url.href.length > 4096) throw new Error("URL 超过4096字符限制");
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("只支持不含凭据的公开 HTTP(S) URL");
  if (
    !url.hostname.includes(".") ||
    /^(localhost|.*\.localhost|.*\.local)$/.test(url.hostname) ||
    /^\[|^\d+(?:\.\d+){0,3}$/.test(url.hostname)
  )
    throw new Error(
      "不接受本机、IP 地址或内网名称；DNS/重定向安全由宿主 web 服务执行",
    );
  if (
    /\/(?:login|signin|auth|sso)(?:\/|$)/i.test(url.pathname) ||
    [...url.searchParams.keys()].some((k) =>
      /^(?:token|access_token|refresh_token|id_token|cookie|authorization|password|ticket|session|sessionid|sid|code|api_key)$/i.test(
        k,
      ),
    )
  )
    throw new Error("公开阅读不接受认证地址或凭据查询参数");
  url.hash = "";
  return url.href;
}

export function canonicalUrl(raw: string): string {
  const url = new URL(publicUrl(raw));
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

export const attachmentPattern =
  /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z)(?:$|[?#])/i;

/** Static HTML only: never executes scripts, loads assets, or follows links. */
export function extractHtml(html: string, origin: string) {
  const root = parse(html);
  const title = root.querySelector("title")?.text.trim().slice(0, 300) ?? null;
  const dateNode = root.querySelector(
    'meta[property="article:published_time"],meta[name="pubdate"],meta[name="publishdate"],time[datetime]',
  );
  const publishedAt =
    dateNode?.getAttribute("content") ??
    dateNode?.getAttribute("datetime") ??
    null;
  root
    .querySelectorAll(
      "script,style,noscript,svg,template,nav,footer,header,form",
    )
    .forEach((n) => n.remove());
  const attachments: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const link of root.querySelectorAll("a[href]")) {
    try {
      const url = publicUrl(link.getAttribute("href")!, origin);
      if (
        (attachmentPattern.test(url) || link.hasAttribute("download")) &&
        !seen.has(url) &&
        attachments.length < 50
      ) {
        seen.add(url);
        attachments.push({ title: link.text.trim().slice(0, 200), url });
      }
    } catch {
      /* Unsafe/non-web link is not exposed. */
    }
  }
  const render = (node: Node): string => {
    if (node.nodeType === NodeType.TEXT_NODE)
      return node.text.replace(/\s+/g, " ");
    if (!(node instanceof HTMLElement)) return "";
    const text = node.childNodes.map(render).join("");
    const tag = node.tagName?.toLowerCase();
    if (tag === "a") {
      try {
        return `[${text.replace(/[\[\]]/g, "").trim()}](<${publicUrl(node.getAttribute("href") ?? "", origin)}>)`;
      } catch {
        return text;
      }
    }
    if (/^h[1-6]$/.test(tag))
      return `\n\n${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (tag === "br") return "\n";
    if (tag === "li") return `\n- ${text.trim()}\n`;
    if (tag === "strong" || tag === "b") return `**${text}**`;
    if (tag === "td" || tag === "th") return `${text} | `;
    if (/^(p|div|section|article|main|ul|ol|tr|blockquote|pre)$/.test(tag))
      return `\n\n${text.trim()}\n\n`;
    return text;
  };
  const body =
    root.querySelector("article,main") ?? root.querySelector("body") ?? root;
  return {
    title,
    publishedAt,
    attachments,
    text: render(body)
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}
