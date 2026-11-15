/** Internal host capability. Never serialize this object or its authentication headers. */
export interface CampusResponse {
  url: string;
  status: number;
  body: string;
}
export interface CampusRequestInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export interface CampusTransport {
  request(url: string, init?: CampusRequestInit): Promise<CampusResponse>;
  /** Anonymous public web request: MUST NOT carry campus cookies or authorization. */
  publicRequest?(
    url: string,
    init?: CampusRequestInit,
  ): Promise<CampusResponse>;
  bindIdentity(): Promise<void>;
  authorizationHeaders(): Promise<Record<string, string>>;
  academic(path: string, init?: CampusRequestInit): Promise<CampusResponse>;
  bootstrap(url: string): Promise<CampusResponse>;
}
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export const FORM = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
};
export function checked(response: CampusResponse): string {
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Campus HTTP ${response.status}`);
  if (
    /^https?:\/\/id\.scu\.edu\.cn\/(?:login|enduser\/login)/i.test(
      response.url,
    ) ||
    /<input[^>]+type=["']password["']/i.test(response.body)
  )
    throw new Error("Campus session expired; sign in again");
  return response.body;
}
export function json<T = Record<string, unknown>>(response: CampusResponse): T {
  const body = checked(response);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("Campus returned invalid JSON (session may have expired)");
  }
}
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const text = (value: unknown): string =>
  value == null ? "" : String(value).trim();
export function integer(value: unknown, fallback: number, max = 10000): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new Error("Expected a positive bounded integer");
  return value;
}
/** Defense in depth: service payloads must not leak authentication material to an agent. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(?:access[_-]?token|refresh[_-]?token|token(?:key)?|authorization|cookie|set-cookie|sessionid|password|clientsecret)$/i.test(
            key,
          ),
      )
      .map(([key, item]) => [key, redactSecrets(item)]),
  );
}
