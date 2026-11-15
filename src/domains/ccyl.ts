// Verified read-only protocol subset from MingYuanHu (AGPL-3.0-or-later).
import {
  checked,
  json as parseJson,
  UA as CAMPUS_USER_AGENT,
  type CampusTransport,
  type CampusResponse as ScuResponse,
} from "./transport";
class CampusAuthError extends Error {}
export function createCcyl(t: CampusTransport) {
  const scuRequest = t.request.bind(t);
  const bindIdentitySession = t.bindIdentity.bind(t);
  const CCYL_BASE = "https://dekt.scu.edu.cn/ccyl-api";
  const ID_BASE = "https://id.scu.edu.cn";
  /** 第二课堂的 sp_code（与 Bugaoshan 一致的公开常量）。 */
  const CCYL_SP_CODE =
    "bDBhREE1WDMzK3llSzZyVFZNeE81czRDd1hESTI4NWxGaFdsTnlvcGt3eVdTb2cxSjN5a1FJTDVMWTBEQkFFd2k1bWZRMy82OXN6V21ZYzFLd2NlSDdUaWlVcVJ1emxVVnF4Q3RZNWxjWlVoTEZqUktVSWVmY1ZaKzBLYUlBWDYvaU5MS1E5Y25nT1BoSzRIM0FIOWVCQjMxMXd5b0JrenNuWDBDM1BKU0FwUVVnZHdoSWYrc0hKZmEwSHRQbFZDV1o2dzFtQ3Nuci9wV1ExZHRMMytueHpLZVg5djJJcGFRbkJxZFJCQWJZWHI2dlpQNHVxNFNhcHM3Y3RkK2g1dWFuUEtNT1JZblFXRFBLUEdrcGdxNHR5eEcxclh5YXQ5a2FXN3JSZ2g2OTAxWCt0TUdTNXJDRVdNeDNTU3duTk1nNW9RSyt4WkdzSjNkR3NvVEFDMzFCQmJHUVcrVitybmszQVd0djFpUUJ5dDJySlRTajZIem1qZFYwMjVWcVpEaUtKd1AwQzI3TUpZd3FyY1hqdkxUZkFCd3JwL3ltczdXcmlTUzhZYVJPR0QwOXk2aDJIdUlCUTAvbEJWd0xzcUZXSElxaENpR0pseG1XYTZRbWlFaklERTd6TlhBQkJLdTZGUS8rNTBBYWRkcDVrRXdBM0tqejMvd1AvTklkZW5oNll4MllINlFiNVRucXNhZWtzUlh3d1BOQzBrMERSM0tId3dyS1hONkF6VDZwRGl3S3h1aDNLSGVmcTBRTktXUXMxTTZxeW1lcmgzYVlGWDNmVHdvUnJkWXVhbHN0aEtHKzU5TnFuVm1NbXU4dnhZQk8zKzQrdnV3aTJEaGY4VXRnV3lHeTVBcFFnWlUyQTFsWjdsR1RyNHh1TjV5dUlVc1VNNTRlbEtETTVVYWZoYnFPTXFrM2MxUHVNSHVHLzRtUFk4cmZzaXNUVkovWlhuSkhWWXpYQUJ4UDE4bGt2NXJkMFlXZHM0cFlYVVduKy9ZWGNKTlBDNEVrSzE3R0NVWDNxcCtiQkVyaXMzaTRXam1wWTFzYkpWZTAxYzZ0VGlxcGkvcEYyLzJPND0=";

  const HEADERS = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    Origin: "https://dekt.scu.edu.cn",
    Referer: "https://dekt.scu.edu.cn",
    "User-Agent": CAMPUS_USER_AGENT,
  };

  interface CcylState {
    token: string;
    userId: string;
    principal: string;
  }

  let state: CcylState = { token: "", userId: "", principal: "" };

  function resetCcyl(): void {
    state = { token: "", userId: "", principal: "" };
  }

  function ccylLoggedIn(): boolean {
    return state.token !== "";
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const textOf = (value: unknown): string =>
    value === null || value === undefined ? "" : String(value).trim();

  function decodeCcyl(
    response: ScuResponse,
    api: string,
  ): Record<string, unknown> {
    if (response.status !== 200)
      throw new Error(`第二课堂请求失败（HTTP ${response.status}）`);
    const body = parseJson<Record<string, unknown>>(response);
    const code = body.code;
    if (code === 401 || code === "401") {
      resetCcyl();
      throw new CampusAuthError("第二课堂登录已失效，请重新连接统一身份认证");
    }
    if (Number(code) !== 0) {
      const message = textOf(body.msg);
      throw new Error(`${message || `第二课堂请求失败`}（${api}）`);
    }
    return body;
  }

  async function requestToken(): Promise<string> {
    await bindIdentitySession();
    const auth = await t.authorizationHeaders();
    const bearer = (auth.Authorization ?? auth.authorization ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (!bearer) throw new CampusAuthError("请先用统一身份认证登录");
    const url = `${ID_BASE}/api/bff/v1.2/commons/sp_logged?${new URLSearchParams(
      {
        access_token: bearer,
        sp_code: CCYL_SP_CODE,
        application_key: "scdxplugin_cas_apereo17",
      },
    )}`;
    const redirect = await scuRequest(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*",
        "User-Agent": HEADERS["User-Agent"],
      },
      timeoutMs: 30_000,
    });
    const codeFromUrl = (() => {
      try {
        return new URL(redirect.url).searchParams.get("code") ?? "";
      } catch {
        return "";
      }
    })();
    // 兜底：从 meta refresh / window.location 里取 code。
    const codeFromBody = (() => {
      const match =
        /http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=([^"'>\s]+)/i.exec(
          redirect.body,
        ) ??
        /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/.exec(
          redirect.body,
        );
      if (!match?.[1]) return "";
      try {
        return new URL(match[1], ID_BASE).searchParams.get("code") ?? "";
      } catch {
        return "";
      }
    })();
    const code = codeFromUrl || codeFromBody;
    if (!code)
      throw new CampusAuthError(
        "第二课堂授权未获得 code，请重新登录统一身份认证",
      );

    const login = await scuRequest(`${CCYL_BASE}/app/auth/loginByUc`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ code }),
      timeoutMs: 30_000,
    });
    const payload = parseJson<Record<string, unknown>>(login);
    if (Number(payload.code) !== 0) {
      throw new Error(`第二课堂登录失败：${textOf(payload.msg) || "未知错误"}`);
    }
    const token = textOf(payload.token);
    if (!token) throw new Error("第二课堂登录响应缺少 token");
    state = {
      token,
      userId: isRecord(payload.user) ? textOf(payload.user.id) : "",
      principal: bearer.slice(0, 8),
    };
    return token;
  }

  /** 业务请求；遇到 token 过期（code=401）时重新授权并重放一次。 */
  async function call(
    api: string,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const run = async (token: string) => {
      const response = await scuRequest(`${CCYL_BASE}${path}`, {
        method: init.method,
        headers: { ...HEADERS, token },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        timeoutMs: 20_000,
      });
      return decodeCcyl(response, api);
    };
    const token = state.token || (await requestToken());
    try {
      return await run(token);
    } catch (error) {
      if (!(error instanceof CampusAuthError)) throw error;
      const next = await requestToken();
      return run(next);
    }
  }

  const post = (api: string, path: string, body: unknown = {}) =>
    call(api, path, { method: "POST", body });
  const get = (api: string, path: string) => call(api, path, { method: "GET" });

  const listOf = (body: Record<string, unknown>, key: string): unknown[] =>
    Array.isArray(body[key]) ? (body[key] as unknown[]) : [];

  const millis = () => String(Date.now());

  interface CcylSearchInput {
    readonly page?: number;
    readonly pageSize?: number;
    readonly name?: string;
    readonly level?: string;
    readonly scoreType?: string;
    readonly org?: string;
    readonly order?: string;
    readonly status?: string;
    readonly quality?: string;
  }

  function searchCcylActivities(input: CcylSearchInput = {}) {
    return post(
      "list-activity-library",
      "/app/activity/list-activity-library",
      {
        pn: input.page ?? 1,
        ps: input.pageSize ?? 20,
        time: millis(),
        name: input.name ?? "",
        level: input.level ?? "",
        scoreType: input.scoreType ?? "",
        org: input.org ?? "",
        order: input.order ?? "",
        status: input.status ?? "",
        quality: input.quality ?? "",
      },
    ).then((body) => listOf(body, "list"));
  }

  function myCcylActivities(page = 1, pageSize = 20) {
    return post("list-mine", "/app/activity/list-mine", {
      pn: page,
      ps: pageSize,
      time: millis(),
    }).then((body) => listOf(body, "content"));
  }

  function orderedCcylActivities(page = 1, pageSize = 20, name = "") {
    return post(
      "list-ordered-activity-library",
      "/app/activity/list-ordered-activity-library",
      {
        pn: page,
        ps: pageSize,
        time: millis(),
        name,
      },
    ).then((body) => listOf(body, "list"));
  }

  function ccylActivityLibrary(id: string) {
    return get(
      "get-lib-detail",
      `/app/activity/get-lib-detail/${encodeURIComponent(id)}`,
    ).then((body) => {
      return {
        activityLib: body.activityLib ?? null,
        activities: listOf(body, "activities"),
        subscribed: body.subscribed === true,
      };
    });
  }

  function ccylActivityDetail(id: string) {
    return post("get-detail", "/app/activity/get-detail", {
      activityId: id,
    }).then((body) => ({
      activity: body.activity ?? null,
      activityLib: body.activityLib ?? null,
      isXtwRole: body.isXtwRole === true,
      signUp: body.signUp === true,
    }));
  }

  function ccylActivityScoreTypes(libraryId: string) {
    return post(
      "list-activity-score",
      `/app/activity/list-activity-score/${encodeURIComponent(libraryId)}`,
      {},
    ).then((body) => listOf(body, "list"));
  }

  function ccylCredits(page = 1, pageSize = 50) {
    return post("list-credit", "/app/credit/list", {
      pn: page,
      ps: pageSize,
    }).then((body) => listOf(body, "list"));
  }

  function ccylOrgs() {
    return post("list-all", "/app/org/list-all", {}).then((body) =>
      listOf(body, "list"),
    );
  }

  return {
    searchCcylActivities,
    myCcylActivities,
    orderedCcylActivities,
    ccylActivityLibrary,
    ccylActivityDetail,
    ccylActivityScoreTypes,
    ccylCredits,
    ccylOrgs,
  };
}
