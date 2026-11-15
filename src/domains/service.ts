// Protocol adapted from MingYuanHu (AGPL-3.0-or-later), read-only subset.
import {
  checked,
  json as parse,
  UA,
  type CampusTransport,
  type CampusResponse,
} from "./transport";
class CampusAuthError extends Error {}
const parseJson = <T>(r: CampusResponse, _service?: string): T => parse<T>(r);

export function createService(t: CampusTransport) {
  const scuRequest = t.request.bind(t);
  const bindIdentitySession = t.bindIdentity.bind(t);
  const bootstrapSso = (url: string, _service?: string) => t.bootstrap(url);
  const SERVICE_BASE = "https://service.scu.edu.cn";
  const SERVICE_LOGIN = `${SERVICE_BASE}/api/login/main?redirect_url=${encodeURIComponent(
    `${SERVICE_BASE}/v2/matter/`,
  )}`;
  const DEFAULT_STARTER_DEPART_ID = "395876";
  const ATTACHMENT_LIMIT = 100 * 1024 * 1024;

  const SERVICE_HEADERS = {
    Accept: "application/json, text/plain, */*",
    Origin: SERVICE_BASE,
    Referer: SERVICE_BASE,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
  };

  interface ServiceEnvelope {
    e?: unknown;
    m?: unknown;
    d?: unknown;
  }

  const FORM_HEADERS = {
    ...SERVICE_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  let serviceReady = false;

  function resetService(): void {
    serviceReady = false;
  }

  async function ensureService(): Promise<void> {
    if (serviceReady) return;
    await bindIdentitySession();
    await bootstrapSso(SERVICE_LOGIN, "办事大厅");
    serviceReady = true;
  }

  function decode(
    response: Awaited<ReturnType<typeof scuRequest>>,
  ): ServiceEnvelope {
    const body = parseJson<ServiceEnvelope>(response, "办事大厅");
    if (body.e === 10042 || body.e === "10042") {
      serviceReady = false;
      throw new CampusAuthError("办事大厅登录已失效，请重新连接统一身份认证");
    }
    if (body.e !== 0 && body.e !== "0") {
      const message =
        typeof body.m === "string" && body.m ? body.m : "办事大厅请求失败";
      throw new Error(message);
    }
    return body;
  }

  async function fetchMyApplications(status = 0, page = 1): Promise<unknown> {
    await ensureService();
    const query = new URLSearchParams({
      p: String(page),
      page_size: "20",
      status: String(status),
      keyword: "",
      time_lower: "",
      time_upper: "",
      y: "",
      task_name: "",
    });
    const response = await scuRequest(
      `${SERVICE_BASE}/site/process/inst-list?${query}`,
      {
        headers: SERVICE_HEADERS,
      },
    );
    const body = decode(response);
    const data: unknown = body.d;
    if (Array.isArray(data)) return data;
    const list = (data as { list?: unknown } | undefined)?.list;
    return Array.isArray(list) ? list : [];
  }

  return { fetchMyApplications };
}
