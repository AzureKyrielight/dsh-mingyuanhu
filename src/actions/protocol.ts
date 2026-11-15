import { createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import type { CampusAction } from "./actions";
import type { ActionBinding, DispatchResult } from "./draft-store";

export interface WriteRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  /** Transport must disable retry/auth-replay and redirect replay for this request. */
  readonly retry: "never";
}
export interface WriteResponse {
  readonly status: number;
  readonly body: string;
}
export interface WriteSession {
  readonly binding: ActionBinding;
  readonly repairTokenKey?: string;
  readonly ccylToken?: string;
  readonly ccylUserId?: string;
}
export interface ActionTransport {
  /** May acquire auth before sending a write; must never issue a business write. */
  session(
    binding: ActionBinding,
    service: "repair" | "ccyl" | "service",
  ): Promise<WriteSession>;
  /** Exactly one attempt, no redirects/retries. Scoped cookie jar must match binding. */
  request(
    request: WriteRequest,
    binding: ActionBinding,
  ): Promise<WriteResponse>;
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function repairToken(key: string): string {
  const cipher = createCipheriv(
    "aes-128-cbc",
    Buffer.from("bf8ec0449942e7f4"),
    Buffer.from("web201911chengdu"),
  );
  return Buffer.concat([
    cipher.update(
      JSON.stringify({
        tokenKey: key,
        clientId: "web201911chengdu",
        timestamp: Date.now(),
        GUID: randomUUID(),
      }),
      "utf8",
    ),
    cipher.final(),
  ]).toString("base64");
}
function decodeRepair(body: string): unknown {
  const decipher = createDecipheriv(
    "aes-128-cbc",
    Buffer.from("1974051005060708"),
    Buffer.from("1974051005060708"),
  );
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(body.trim(), "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}
/** Real wire protocol; no filesystem, browser, global fetch, or automatic retry. */
export function createActionDispatcher(transport: ActionTransport) {
  return async (
    action: CampusAction,
    binding: ActionBinding,
  ): Promise<DispatchResult> => {
    const service = action.kind.startsWith("repair.")
      ? "repair"
      : action.kind.startsWith("ccyl.")
        ? "ccyl"
        : "service";
    const session = await transport.session(binding, service);
    if (
      session.binding.ownerId !== binding.ownerId ||
      session.binding.accountId !== binding.accountId ||
      session.binding.sessionGeneration !== binding.sessionGeneration
    )
      throw new Error("Session changed");
    let url: string;
    let body: string;
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
    };
    if (service === "repair") {
      if (!session.repairTokenKey)
        throw new Error("Repair authentication required");
      headers.Token = repairToken(session.repairTokenKey);
      headers.TokenKey = session.repairTokenKey;
      headers.Origin = "https://zhhq.scu.edu.cn";
      headers.Referer = "https://zhhq.scu.edu.cn/ihome/newrepair";
      headers["X-Requested-With"] = "XMLHttpRequest";
    } else if (service === "ccyl") {
      if (!session.ccylToken) throw new Error("CCYL authentication required");
      headers.token = session.ccylToken;
      headers.Origin = "https://dekt.scu.edu.cn";
      headers.Referer = "https://dekt.scu.edu.cn";
    } else {
      headers.Origin = "https://service.scu.edu.cn";
      headers.Referer = headers.Origin;
      headers["X-Requested-With"] = "XMLHttpRequest";
    }
    headers["Content-Type"] = "application/json;charset=UTF-8";
    switch (action.kind) {
      case "repair.submit":
        url = "https://zhhq.scu.edu.cn/api/repair/publish/publish";
        body = JSON.stringify(action.payload);
        break;
      case "repair.withdraw":
        url = "https://zhhq.scu.edu.cn/api/repair/myRepair/withdrawMyRepair";
        headers["Content-Type"] =
          "application/x-www-form-urlencoded; charset=UTF-8";
        body = new URLSearchParams(action.payload).toString();
        break;
      case "ccyl.signup":
        url = "https://dekt.scu.edu.cn/ccyl-api/app/activity/sign-up-act";
        body = JSON.stringify(action.payload);
        break;
      case "ccyl.cancel-signup":
        if (!session.ccylUserId || session.ccylUserId !== action.payload.userId)
          throw new Error("CCYL user changed");
        url = "https://dekt.scu.edu.cn/ccyl-api/app/activity/cancel";
        body = JSON.stringify(action.payload);
        break;
      case "ccyl.subscribe":
      case "ccyl.cancel-subscribe":
        url = `https://dekt.scu.edu.cn/ccyl-api/app/activity/${action.kind === "ccyl.subscribe" ? "subscribe-act" : "cancel-subscribe"}/${encodeURIComponent(action.payload.libraryId)}`;
        body = "{}";
        break;
      case "service.submit":
        url = "https://service.scu.edu.cn/site/process/launch";
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams({
          data: JSON.stringify({
            app_id: action.payload.appId,
            node_id: "",
            form_data: action.payload.formData,
            userview: 1,
          }),
          step: "0",
          agent_uid: "",
          starter_depart_id: action.payload.starterDepartId,
        }).toString();
        break;
      default:
        throw new Error("Unsupported action");
    }
    const response = await transport.request(
      { url, method: "POST", headers, body, timeoutMs: 30_000, retry: "never" },
      binding,
    );
    // HTTP/parse/auth failure can occur after acceptance. Let store classify unknown, never retry.
    if (response.status !== 200)
      throw new Error("Submission HTTP outcome uncertain");
    const decoded: unknown =
      service === "repair"
        ? decodeRepair(response.body)
        : JSON.parse(response.body);
    if (!record(decoded)) throw new Error("Unrecognized submission response");
    if (service === "repair") {
      if (
        decoded.status === "success" &&
        (decoded.errorCode === 0 ||
          decoded.errorCode === "0" ||
          decoded.errorCode === undefined)
      )
        return { status: "succeeded" };
      if (decoded.status === "error" || decoded.status === "fail")
        return {
          status: "rejected",
          message: "Campus repair service rejected the request",
        };
    } else if (service === "ccyl") {
      if (decoded.code === 0 || decoded.code === "0")
        return { status: "succeeded" };
      if (typeof decoded.code === "number" || typeof decoded.code === "string")
        return {
          status: "rejected",
          message: "Campus CCYL service rejected the request",
        };
    } else {
      if (decoded.e === 0 || decoded.e === "0") return { status: "succeeded" };
      if (typeof decoded.e === "number" || typeof decoded.e === "string")
        return {
          status: "rejected",
          message: "Campus service rejected the request",
        };
    }
    throw new Error("Unrecognized submission response");
  };
}
