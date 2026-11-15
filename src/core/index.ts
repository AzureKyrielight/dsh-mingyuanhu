import { AsyncLocalStorage } from "node:async_hooks";
import { sm2 } from "sm-crypto";
import { CookieJar } from "./cookie-jar.js";
import { recognizeCaptchaBase64 } from "./ocr/captcha.js";

export const CAMPUS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TOKEN_TTL = 60 * 60 * 1000;
const ID = "https://id.scu.edu.cn";
const ACADEMIC = "http://zhjw.scu.edu.cn";
const WFW = "https://wfw.scu.edu.cn";
const PAY = "https://payapp.scu.edu.cn/eleFees";
export type CampusErrorCode =
  | "network"
  | "timeout"
  | "invalid_response"
  | "auth"
  | "captcha"
  | "not_bound"
  | "invalid_input";
export class CampusError extends Error {
  readonly name = "CampusError";
  constructor(
    readonly code: CampusErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export interface CampusStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
  clear(): Promise<void>;
}
export interface CampusClientOptions {
  store?: CampusStore;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}
export type CaptchaInput =
  { mode: "auto" } | { mode: "manual"; challengeId: string; text: string };
interface Session {
  token: string;
  username: string;
  loginAt: number;
}
interface ResponseData {
  status: number;
  url: string;
  body: string;
}

export function encryptPassword(password: string, publicKey: string): string {
  const bytes = Buffer.from(publicKey, "base64");
  const hex =
    bytes.length === 64
      ? `04${bytes.toString("hex")}`
      : bytes.length === 65 && bytes[0] === 4
        ? bytes.toString("hex")
        : null;
  if (!hex) throw new CampusError("invalid_response", "SM2 公钥格式异常");
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(sm2.doEncrypt(password, hex, 0), "hex"),
  ]).toString("base64");
}

export class CampusClient {
  private readonly request: typeof globalThis.fetch;
  private readonly store?: CampusStore;
  private readonly initialSignal?: AbortSignal;
  private readonly signals = new AsyncLocalStorage<AbortSignal | undefined>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly jar = new CookieJar();
  private session: Session | null = null;
  private restoreTask?: Promise<void>;
  private readonly bound = new Set<string>();
  private readonly challenges = new Map<
    string,
    { code: string; image: string; expiresAt: number }
  >();
  constructor(options: CampusClientOptions = {}) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.store = options.store;
    this.initialSignal = options.signal;
  }
  withSignal<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const task = this.queue.then(() =>
      this.signals.run(signal, async () => {
        signal?.throwIfAborted();
        return operation();
      }),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async restore(): Promise<void> {
    this.restoreTask ??= (async () => {
      const value = await this.store?.load();
      if (!value || typeof value !== "object") return;
      const s = value as Partial<Session>;
      if (
        typeof s.token === "string" &&
        /^\d{6,20}$/.test(String(s.username)) &&
        typeof s.loginAt === "number" &&
        s.loginAt <= Date.now() &&
        Date.now() - s.loginAt < TOKEN_TTL
      ) {
        this.session = {
          token: s.token,
          username: s.username!,
          loginAt: s.loginAt,
        };
      }
    })();
    await this.restoreTask;
  }
  async status() {
    await this.restore();
    const alive =
      this.session !== null && Date.now() - this.session.loginAt < TOKEN_TTL;
    return {
      connected: alive,
      principal: alive
        ? `${this.session!.username.slice(0, 2)}****${this.session!.username.slice(-2)}`
        : null,
      expiresAt: alive
        ? new Date(this.session!.loginAt + TOKEN_TTL).toISOString()
        : null,
    };
  }
  private async identity(): Promise<Session> {
    await this.restore();
    if (!this.session || Date.now() - this.session.loginAt >= TOKEN_TTL)
      throw new CampusError("auth", "请在明远湖光账号面板重新登录");
    return this.session;
  }
  private async http(
    url: string,
    init: RequestInit = {},
  ): Promise<ResponseData> {
    let current = new URL(url);
    let method = init.method ?? "GET";
    let body = init.body;
    const headers = new Headers(init.headers);
    headers.set("User-Agent", CAMPUS_USER_AGENT);
    const outer = this.signals.getStore() ?? this.initialSignal;
    const signal = AbortSignal.any([
      AbortSignal.timeout(45_000),
      ...(outer ? [outer] : []),
    ]);
    for (let hop = 0; hop <= 10; hop++) {
      if (
        !["http:", "https:"].includes(current.protocol) ||
        current.username ||
        current.password ||
        !(
          current.hostname === "scu.edu.cn" ||
          current.hostname.endsWith(".scu.edu.cn")
        )
      )
        throw new CampusError("network", "请求目标不在四川大学校园域名内");
      const requestHeaders = new Headers(headers);
      const cookie = this.jar.header(current.toString());
      if (cookie) requestHeaders.set("Cookie", cookie);
      try {
        signal.throwIfAborted();
        const response = await this.request(current, {
          ...init,
          method,
          body,
          headers: requestHeaders,
          redirect: "manual",
          signal,
        });
        for (const line of response.headers.getSetCookie())
          this.jar.store(line, current.toString());
        const location = response.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          await response.body?.cancel();
          const next = new URL(location.replaceAll(" ", "%20"), current);
          if (next.origin !== current.origin) headers.delete("Authorization");
          if (response.status !== 307 && response.status !== 308) {
            method = "GET";
            body = undefined;
            headers.delete("Content-Type");
          }
          current = next;
          continue;
        }
        const reader = response.body?.getReader();
        const decoder = new TextDecoder("utf-8");
        let text = "";
        let bytes = 0;
        if (reader) {
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 2 * 1024 * 1024)
                throw new CampusError("invalid_response", "校园服务响应过大");
              text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        }
        if (response.status === 401 || response.status === 403)
          throw new CampusError("auth", "校园会话已失效，请重新登录");
        if (!response.ok)
          throw new CampusError(
            "invalid_response",
            `校园服务返回 HTTP ${response.status}`,
          );
        return { status: response.status, url: current.toString(), body: text };
      } catch (error) {
        if (error instanceof CampusError) throw error;
        if (signal.aborted)
          throw new CampusError("timeout", "校园请求已取消或超时");
        throw new CampusError(
          "network",
          "无法连接校园服务，请检查校园网或 VPN",
        );
      }
    }
    throw new CampusError("network", "校园服务重定向次数过多");
  }
  private json<T>(response: ResponseData): T {
    if (
      new URL(response.url).hostname === "id.scu.edu.cn" &&
      response.body.trimStart().startsWith("<")
    )
      throw new CampusError("auth", "校园会话已失效，请重新登录");
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new CampusError("invalid_response", "校园接口未返回有效数据");
    }
  }
  async challenge(): Promise<{ challengeId: string; image: string }> {
    const data = this.json<{ data?: { captcha?: unknown; code?: unknown } }>(
      await this.http(
        `${ID}/api/public/bff/v1.2/one_time_login/captcha?_enterprise_id=scdx&timestamp=${Date.now()}`,
      ),
    );
    if (
      typeof data.data?.captcha !== "string" ||
      typeof data.data.code !== "string"
    )
      throw new CampusError("captcha", "验证码获取失败");
    this.challenges.clear();
    const challengeId = crypto.randomUUID();
    this.challenges.set(challengeId, {
      code: data.data.code,
      image: data.data.captcha,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return { challengeId, image: data.data.captcha };
  }
  async signIn(input: {
    username: string;
    password: string;
    captcha: CaptchaInput;
    rememberSession: boolean;
  }) {
    if (!/^\d{6,20}$/.test(input.username.trim()) || !input.password)
      throw new CampusError("invalid_input", "请输入有效学号和密码");
    if ((await this.status()).connected)
      throw new CampusError("invalid_input", "切换账号前请先退出");
    let captcha = input.captcha;
    if (captcha.mode === "auto") {
      const challenge = await this.challenge();
      let text: string;
      try {
        text = recognizeCaptchaBase64(challenge.image).text;
      } catch {
        throw new CampusError("captcha", "验证码识别失败，请手动输入");
      }
      if (!text) throw new CampusError("captcha", "验证码识别失败，请手动输入");
      captcha = { mode: "manual", challengeId: challenge.challengeId, text };
    }
    const challenge = this.challenges.get(captcha.challengeId);
    this.challenges.delete(captcha.challengeId);
    if (!challenge || challenge.expiresAt <= Date.now() || !captcha.text.trim())
      throw new CampusError("captcha", "请重新获取验证码");
    const headers = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: ID,
      Referer: `${ID}/frontend/login`,
    };
    const key = this.json<{ data?: { publicKey?: unknown; code?: unknown } }>(
      await this.http(`${ID}/api/public/bff/v1.2/sm2_key`, {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
    if (
      typeof key.data?.publicKey !== "string" ||
      typeof key.data.code !== "string"
    )
      throw new CampusError("invalid_response", "无法获取登录加密密钥");
    const response = await this.http(`${ID}/api/public/bff/v1.2/rest_token`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: "1371cbeda563697537f28d99b4744a973uDKtgYqL5B",
        grant_type: "password",
        scope: "read",
        username: input.username.trim(),
        password: encryptPassword(input.password, key.data.publicKey),
        _enterprise_id: "scdx",
        sm2_code: key.data.code,
        cap_code: challenge.code,
        cap_text: captcha.text.trim(),
      }),
    });
    const result = this.json<{
      success?: unknown;
      message?: unknown;
      data?: { access_token?: unknown };
    }>(response);
    if (
      result.success !== true ||
      typeof result.data?.access_token !== "string"
    ) {
      throw new CampusError(
        typeof result.message === "string" &&
          /captcha|验证码/i.test(result.message)
          ? "captcha"
          : "auth",
        "登录失败，请检查密码和验证码后重试",
      );
    }
    this.jar.drop(() => true);
    this.bound.clear();
    this.session = {
      token: result.data.access_token,
      username: input.username.trim(),
      loginAt: Date.now(),
    };
    if (input.rememberSession) await this.store?.save(this.session);
    else await this.store?.clear();
    return this.status();
  }
  async signOut(): Promise<void> {
    await this.restore();
    this.session = null;
    this.jar.drop(() => true);
    this.challenges.clear();
    this.bound.clear();
    await this.store?.clear();
  }
  private async bindIdentity(): Promise<void> {
    const session = await this.identity();
    if (this.bound.has("identity")) return;
    this.jar.drop(
      (c) =>
        c.domain === "id.scu.edu.cn" || c.domain.endsWith(".id.scu.edu.cn"),
    );
    const result = this.json<{ success?: unknown }>(
      await this.http(`${ID}/api/bff/v1.2/commons/session/save`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
          Origin: ID,
          Referer: `${ID}/frontend/login`,
        },
        body: "{}",
      }),
    );
    if (result.success !== true)
      throw new CampusError("auth", "统一认证会话建立失败，请重新登录");
    this.bound.add("identity");
  }
  private async bootstrap(url: string): Promise<ResponseData> {
    const session = await this.identity();
    const run = () =>
      this.http(url, {
        headers: {
          Authorization: `Bearer ${session.token}`,
          Accept: "text/html,application/xhtml+xml,*/*",
        },
      });
    let response: ResponseData;
    try {
      response = await run();
    } catch (error) {
      if (!(error instanceof CampusError) || error.code !== "auth") throw error;
      response = await run();
    }
    if (
      new URL(response.url).hostname === "id.scu.edu.cn" ||
      /<title>[^<]*统一身份认证|\/frontend\/login/.test(
        response.body.slice(0, 4096),
      )
    )
      throw new CampusError("auth", "校园单点登录失败，请重新登录");
    return response;
  }
  private async academic(
    path: string,
    init?: RequestInit,
  ): Promise<ResponseData> {
    await this.bindIdentity();
    if (!this.bound.has("academic")) {
      const response = await this.bootstrap(
        `${ID}/enduser/sp/sso/scdxplugin_jwt23?enterpriseId=scdx&target_url=index`,
      );
      if (new URL(response.url).origin !== ACADEMIC)
        throw new CampusError("auth", "教务会话建立失败");
      this.bound.add("academic");
    }
    const response = await this.http(`${ACADEMIC}${path}`, init);
    if (
      new URL(response.url).origin !== ACADEMIC ||
      /<title>[^<]*登录|name="password"/i.test(response.body.slice(0, 4096))
    ) {
      this.bound.delete("academic");
      throw new CampusError("auth", "教务登录已失效");
    }
    return response;
  }
  async semesters(): Promise<{ value: string; label: string }[]> {
    const response = await this.academic(
      "/student/courseSelect/calendarSemesterCurriculum/index",
    );
    const rows = [
      ...response.body.matchAll(
        /<option[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g,
      ),
    ].map((m) => ({ value: m[1], label: m[2].replace(/<[^>]+>/g, "").trim() }));
    if (!rows.length)
      throw new CampusError("invalid_response", "未读取到教务学期");
    return rows;
  }
  async grades(input: { scheme?: boolean } = {}): Promise<unknown> {
    const kind = input.scheme ? "schemeScores" : "allPassingScores";
    const path = `/student/integratedQuery/scoreQuery/${kind}/index`;
    const response = await this.academic(path);
    const callback = new RegExp(
      `var\\s+url\\s*=\\s*"(/student/integratedQuery/scoreQuery/[^/]+/${kind}/callback)"`,
    ).exec(response.body)?.[1];
    if (!callback)
      throw new CampusError("invalid_response", "无法从教务页面读取成绩接口");
    return this.json(
      await this.academic(callback, {
        headers: { Accept: "application/json", Referer: `${ACADEMIC}${path}` },
      }),
    );
  }
  async schedule(input: { planCode: string }): Promise<unknown> {
    if (!/^\d{4}-\d{4}-\d+-\d+$/.test(input.planCode))
      throw new CampusError(
        "invalid_input",
        "请先查询学期并使用返回的 planCode",
      );
    return this.json(
      await this.academic(
        "/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            Referer: `${ACADEMIC}/student/courseSelect/calendarSemesterCurriculum/index`,
          },
          body: new URLSearchParams(input).toString(),
        },
      ),
    );
  }
  private async profile(): Promise<{ name: string; number: string }> {
    await this.bindIdentity();
    const response = await this.http(`${WFW}/uc/wap/user/get-info`);
    const result = this.json<{
      e?: unknown;
      d?: { base?: { realname?: unknown; role?: { number?: unknown } } };
    }>(response);
    if (result.e !== 0 && result.e !== "0")
      throw new CampusError("auth", "微服务会话已失效");
    const profile = result.d?.base;
    if (
      typeof profile?.realname !== "string" ||
      typeof profile.role?.number !== "string"
    )
      throw new CampusError("invalid_response", "无法读取本人电费查询信息");
    return { name: profile.realname, number: profile.role.number };
  }
  private async pay(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.bound.has("pay")) {
      await this.profile();
      await this.bootstrap(`${PAY}/oauth/airWarrant`);
      this.bound.add("pay");
    }
    await this.identity();
    const response = await this.http(`${PAY}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Origin: "https://payapp.scu.edu.cn",
        Referer: "https://payapp.scu.edu.cn",
      },
      body: JSON.stringify(payload),
    });
    const result = this.json<{ respCode?: unknown; data?: unknown }>(response);
    if (result.respCode !== "00")
      throw new CampusError(
        path === "/electric/queryRoomInfo" ? "not_bound" : "invalid_response",
        "缴费平台未返回有效数据，请检查本人房间绑定",
      );
    return result.data;
  }
  async balanceCampus(): Promise<unknown> {
    return this.pay("/electric/getCampus", {});
  }
  async balanceBuildings(input: { schoolCode: string }): Promise<unknown> {
    return this.pay("/electric/getArchitecture", input);
  }
  async balanceUnits(input: {
    schoolCode: string;
    regCode: string;
  }): Promise<unknown> {
    return this.pay("/electric/getUnit", input);
  }
  async balance(input: { type: 1 | 2 }): Promise<unknown> {
    if (input.type !== 1 && input.type !== 2)
      throw new CampusError("invalid_input", "请选择照明或空调电费");
    const profile = await this.profile();
    return this.pay("/electric/queryRoomInfo", {
      cusNo: profile.number,
      type: input.type,
      cusName: profile.name,
    });
  }
}
export default CampusClient;
