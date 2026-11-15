// Verified read-only protocol subset from MingYuanHu (AGPL-3.0-or-later).
import {
  checked,
  json as parseJson,
  UA as CAMPUS_USER_AGENT,
  type CampusTransport,
  type CampusResponse as ScuResponse,
} from "./transport";
class CampusAuthError extends Error {}
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function createRepair(t: CampusTransport) {
  const scuRequest = t.request.bind(t);
  const bindIdentitySession = t.bindIdentity.bind(t);
  const BASE = "https://zhhq.scu.edu.cn/api";
  const CAS_URL =
    "https://id.scu.edu.cn/enduser/sp/sso/scdxplugin_jwt31?enterpriseId=scdx";
  const RESPONSE_KEY = "1974051005060708";
  const RESPONSE_IV = "1974051005060708";
  const CLIENT_ID = "web201911chengdu";
  const CLIENT_SECRET = "bf8ec0449942e7f4";
  const IMAGE_LIMIT = 10 * 1024 * 1024;
  const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "heif"]);

  let tokenKey = "";
  let ready = false;

  function resetRepair(): void {
    tokenKey = "";
    ready = false;
  }

  function encrypt(plain: string, key: string, iv: string): string {
    const cipher = createCipheriv(
      "aes-128-cbc",
      Buffer.from(key, "utf8"),
      Buffer.from(iv, "utf8"),
    );
    return Buffer.concat([
      cipher.update(plain, "utf8"),
      cipher.final(),
    ]).toString("base64");
  }

  function decrypt(cipherText: string): string {
    const decipher = createDecipheriv(
      "aes-128-cbc",
      Buffer.from(RESPONSE_KEY, "utf8"),
      Buffer.from(RESPONSE_IV, "utf8"),
    );
    return Buffer.concat([
      decipher.update(Buffer.from(cipherText.trim(), "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  /** GUID 只影响签名的新鲜度，用 crypto 随机字节生成 v4 形态即可。 */
  function guid(): string {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** 业务请求头 Token：AES({tokenKey, clientId, timestamp, GUID})。 */
  function buildRepairToken(key: string): string {
    return encrypt(
      JSON.stringify({
        tokenKey: key,
        clientId: CLIENT_ID,
        timestamp: Date.now(),
        GUID: guid(),
      }),
      CLIENT_SECRET,
      CLIENT_ID,
    );
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const textOf = (value: unknown): string =>
    value === null || value === undefined ? "" : String(value).trim();

  interface ZhhqEnvelope extends Record<string, unknown> {
    status?: unknown;
    errorCode?: unknown;
    message?: unknown;
    data?: unknown;
  }

  function decodeEnvelope(
    body: string,
    status: number,
    service = "报修",
  ): ZhhqEnvelope {
    if (status === 302 || status === 401 || status === 403 || !body.trim())
      throw new CampusAuthError("智慧后勤登录已失效，请重新连接统一身份认证");
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypt(body)) as unknown;
    } catch {
      throw new Error(`${service}返回了无法识别的数据`);
    }
    if (!isRecord(parsed)) throw new Error(`${service}响应结构异常`);
    const code = Number(textOf(parsed.errorCode));
    if (Number.isFinite(code) && code >= 4010 && code <= 4017) {
      ready = false;
      tokenKey = "";
      throw new CampusAuthError(`${service}会话已失效，请重新登录`);
    }
    const statusText = textOf(parsed.status);
    const codeText = textOf(parsed.errorCode);
    if (
      (statusText && statusText !== "success") ||
      (codeText && codeText !== "0")
    ) {
      throw new Error(textOf(parsed.message) || `${service}操作失败`);
    }
    return parsed as ZhhqEnvelope;
  }

  /** 静默登录：jwt31 回跳 → userinfo → login/auto → tokenKey。 */
  async function login(): Promise<string> {
    await bindIdentitySession();
    const redirect = await scuRequest(CAS_URL, {
      headers: {
        Accept: "text/html,application/xhtml+xml,*/*",
        "User-Agent": CAMPUS_USER_AGENT,
        ...(await t.authorizationHeaders()),
      },
      timeoutMs: 30_000,
    });
    if (redirect.status === 401 || redirect.status === 403)
      throw new CampusAuthError("智慧后勤单点登录已失效");
    let userinfo = "";
    try {
      userinfo = new URL(redirect.url).searchParams.get("userinfo") ?? "";
    } catch {
      userinfo = "";
    }
    if (!userinfo) throw new CampusAuthError("智慧后勤认证回跳缺少 userinfo");

    const form = new URLSearchParams({
      userInfo: encodeURIComponent(userinfo),
      clientId: CLIENT_ID,
      timestamp: encrypt(String(Date.now()), RESPONSE_KEY, RESPONSE_IV),
      schoolCode: "10610",
      schoolName: "四川大学",
    });
    const response = await scuRequest(`${BASE}/auth/login/auto`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: "https://zhhq.scu.edu.cn",
        Referer: "https://zhhq.scu.edu.cn/account/login",
        "User-Agent": CAMPUS_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: form.toString(),
      timeoutMs: 30_000,
    });
    const envelope = decodeEnvelope(response.body, response.status, "报修");
    const key = textOf(envelope.data);
    if (key.length < 16)
      throw new CampusAuthError("智慧后勤未返回有效的 tokenKey");
    ready = true;
    tokenKey = key;
    return key;
  }

  async function session(): Promise<string> {
    if (ready && tokenKey) return tokenKey;
    return login();
  }

  function headers(key: string, jsonBody: boolean): Record<string, string> {
    return {
      Accept: "application/json, text/plain, */*",
      "Content-Type": jsonBody
        ? "application/json;charset=utf-8"
        : "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: "https://zhhq.scu.edu.cn",
      Referer: "https://zhhq.scu.edu.cn/ihome/newrepair",
      "User-Agent": CAMPUS_USER_AGENT,
      "X-Requested-With": "XMLHttpRequest",
      Token: buildRepairToken(key),
      TokenKey: key,
    };
  }

  /** Read-only requests retry once when the encrypted response reports expired auth. */
  async function request(
    run: (key: string) => Promise<ScuResponse>,
    service = "报修",
  ): Promise<ZhhqEnvelope> {
    const key = await session();
    const execute = async (key: string) => {
      const response = await run(key);
      return decodeEnvelope(response.body, response.status, service);
    };
    try {
      return await execute(key);
    } catch (error) {
      if (!(error instanceof CampusAuthError)) throw error;
      resetRepair();
      return execute(await login());
    }
  }

  function postForm(
    path: string,
    form: Record<string, string> = {},
  ): Promise<ZhhqEnvelope> {
    const body = new URLSearchParams(form).toString();
    return request((key) =>
      scuRequest(`${BASE}${path}`, {
        method: "POST",
        headers: headers(key, false),
        body,
        timeoutMs: 20_000,
      }),
    );
  }

  const listOf = (envelope: ZhhqEnvelope): unknown[] =>
    Array.isArray(envelope.data) ? (envelope.data as unknown[]) : [];

  const stringsOf = (envelope: ZhhqEnvelope): string[] =>
    listOf(envelope)
      .map((item) => textOf(item))
      .filter(Boolean);

  interface RepairAddress {
    readonly id: string;
    readonly areaId: string;
    readonly areaName: string;
    readonly addressDetail: string;
    readonly phone: string;
    readonly isCommon: boolean;
    readonly userId: string;
  }

  function mapAddress(raw: unknown): RepairAddress {
    const value = isRecord(raw) ? raw : {};
    return {
      id: textOf(value.id),
      areaId: textOf(value.areaId),
      areaName: textOf(value.areaName),
      addressDetail: textOf(value.addressDetail),
      phone: textOf(value.phone),
      isCommon: textOf(value.ifCommon) === "1",
      userId: textOf(value.createUser) || textOf(value.userId),
    };
  }

  async function fetchRepairAddresses(): Promise<RepairAddress[]> {
    const envelope = await postForm("/repair/oneNetPublish/getCommonAddress");
    return listOf(envelope).map(mapAddress);
  }

  interface RepairTicket {
    readonly id: string;
    readonly status: string;
    readonly createTime: string;
    readonly content: string;
    readonly address: string;
  }

  function mapTicket(raw: unknown): RepairTicket {
    const value = isRecord(raw) ? raw : {};
    const content = value.content;
    const parsed = (() => {
      if (!isRecord(content)) return {};
      return content;
    })();
    return {
      // 列表行的 id 不是工单 id，撤回/详情要用 activeId（对齐 SCU-CLI）。
      id: textOf(value.activeId) || textOf(value.id),
      status: textOf(value.status) || textOf(value.flowStatus),
      createTime: textOf(value.createTime),
      content:
        textOf(value.contentText) ||
        textOf(parsed.text) ||
        (typeof content === "string" ? content : ""),
      address: textOf(value.areaName) || textOf(value.address),
    };
  }

  /** 「我的动态」工单列表：按 createUser + systemCode=newRepair 过滤。 */
  async function fetchRepairTickets(userId: string): Promise<RepairTicket[]> {
    const search = JSON.stringify([
      {
        andOr: "and",
        searchField: "createUser",
        operator: "=",
        searchValue: userId,
      },
      {
        andOr: "and",
        searchField: "systemCode",
        operator: "=",
        searchValue: "newRepair",
      },
    ]);
    const envelope = await postForm("/manager/activeTemplateData/list", {
      search,
      order: "createTime desc",
    });
    const data = envelope.data;
    const rows = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.rows)
        ? data.rows
        : isRecord(data) && Array.isArray(data.list)
          ? data.list
          : [];
    return rows.map(mapTicket);
  }

  async function fetchMyRepairTickets(): Promise<RepairTicket[]> {
    const addresses = await fetchRepairAddresses();
    const ids = [...new Set(addresses.map((a) => a.userId).filter(Boolean))];
    if (ids.length !== 1)
      throw new Error(
        "Cannot establish own repair user ID from common addresses; unsupported without verified identity",
      );
    return fetchRepairTickets(ids[0]);
  }

  return { fetchMyRepairTickets };
}
