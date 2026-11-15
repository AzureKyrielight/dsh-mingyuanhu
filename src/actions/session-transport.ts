import { createCipheriv, createDecipheriv } from "node:crypto";
import {
  UA,
  record,
  text,
  type CampusTransport,
  type CampusResponse,
} from "../domains/transport";
import type { ActionBinding } from "./draft-store";
import type { ActionTransport, WriteSession } from "./protocol";

export interface CampusWriteTransport extends CampusTransport {
  /** Core-owned one-shot POST: redirects rejected, no retry/auth replay. */
  writeOnce(
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      timeoutMs?: number;
    },
  ): Promise<CampusResponse>;
}
const CCYL_SP_CODE =
  "bDBhREE1WDMzK3llSzZyVFZNeE81czRDd1hESTI4NWxGaFdsTnlvcGt3eVdTb2cxSjN5a1FJTDVMWTBEQkFFd2k1bWZRMy82OXN6V21ZYzFLd2NlSDdUaWlVcVJ1emxVVnF4Q3RZNWxjWlVoTEZqUktVSWVmY1ZaKzBLYUlBWDYvaU5MS1E5Y25nT1BoSzRIM0FIOWVCQjMxMXd5b0JrenNuWDBDM1BKU0FwUVVnZHdoSWYrc0hKZmEwSHRQbFZDV1o2dzFtQ3Nuci9wV1ExZHRMMytueHpLZVg5djJJcGFRbkJxZFJCQWJZWHI2dlpQNHVxNFNhcHM3Y3RkK2g1dWFuUEtNT1JZblFXRFBLUEdrcGdxNHR5eEcxclh5YXQ5a2FXN3JSZ2g2OTAxWCt0TUdTNXJDRVdNeDNTU3duTk1nNW9RSyt4WkdzSjNkR3NvVEFDMzFCQmJHUVcrVitybmszQVd0djFpUUJ5dDJySlRTajZIem1qZFYwMjVWcVpEaUtKd1AwQzI3TUpZd3FyY1hqdkxUZkFCd3JwL3ltczdXcmlTUzhZYVJPR0QwOXk2aDJIdUlCUTAvbEJWd0xzcUZXSElxaENpR0pseG1XYTZRbWlFaklERTd6TlhBQkJLdTZGUS8rNTBBYWRkcDVrRXdBM0tqejMvd1AvTklkZW5oNll4MllINlFiNVRucXNhZWtzUlh3d1BOQzBrMERSM0tId3dyS1hONkF6VDZwRGl3S3h1aDNLSGVmcTBRTktXUXMxTTZxeW1lcmgzYVlGWDNmVHdvUnJkWXVhbHN0aEtHKzU5TnFuVm1NbXU4dnhZQk8zKzQrdnV3aTJEaGY4VXRnV3lHeTVBcFFnWlUyQTFsWjdsR1RyNHh1TjV5dUlVc1VNNTRlbEtETTVVYWZoYnFPTXFrM2MxUHVNSHVHLzRtUFk4cmZzaXNUVkovWlhuSkhWWXpYQUJ4UDE4bGt2NXJkMFlXZHM0cFlYVVduKy9ZWGNKTlBDNEVrSzE3R0NVWDNxcCtiQkVyaXMzaTRXam1wWTFzYkpWZTAxYzZ0VGlxcGkvcEYyLzJPND0=";
const repairKey = Buffer.from("1974051005060708");
function encryptTimestamp(): string {
  const cipher = createCipheriv("aes-128-cbc", repairKey, repairKey);
  return Buffer.concat([
    cipher.update(String(Date.now()), "utf8"),
    cipher.final(),
  ]).toString("base64");
}
function repairEnvelope(response: CampusResponse): Record<string, unknown> {
  if (response.status !== 200) throw new Error("Repair login HTTP failure");
  const decipher = createDecipheriv("aes-128-cbc", repairKey, repairKey);
  const parsed: unknown = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(response.body.trim(), "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
  if (
    !record(parsed) ||
    (parsed.status !== undefined && parsed.status !== "success") ||
    (parsed.errorCode !== undefined &&
      parsed.errorCode !== 0 &&
      parsed.errorCode !== "0")
  )
    throw new Error("Repair login rejected");
  return parsed;
}
function same(a: ActionBinding | null, b: ActionBinding): boolean {
  return (
    a !== null &&
    a.ownerId === b.ownerId &&
    a.accountId === b.accountId &&
    a.sessionGeneration === b.sessionGeneration
  );
}
/** Host-only authentication adapter. Never expose session() results to tools/UI.
 * currentBinding must read live Host identity, not user JSON. Core must serialize
 * account replacement against in-flight I/O or supply an account-scoped cookie jar.
 * No token cache: each draft commit authenticates once before its single write.
 */
export function createSessionActionTransport(
  t: CampusWriteTransport,
  currentBinding: () => ActionBinding | null,
): ActionTransport {
  const assertBinding = (binding: ActionBinding) => {
    if (!same(currentBinding(), binding))
      throw new Error("Campus account/session changed");
  };
  return {
    async session(binding, service): Promise<WriteSession> {
      assertBinding(binding);
      if (service === "service")
        throw new Error(
          "Dynamic service submission is unsupported until the full schema preparation path is integrated",
        );
      await t.bindIdentity();
      assertBinding(binding);
      const auth = await t.authorizationHeaders();
      assertBinding(binding);
      if (service === "ccyl") {
        const bearer = (auth.Authorization ?? auth.authorization ?? "").replace(
          /^Bearer\s+/i,
          "",
        );
        if (!bearer) throw new Error("Identity login required");
        const redirect = await t.request(
          `https://id.scu.edu.cn/api/bff/v1.2/commons/sp_logged?${new URLSearchParams({ access_token: bearer, sp_code: CCYL_SP_CODE, application_key: "scdxplugin_cas_apereo17" })}`,
          {
            headers: {
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*",
              "User-Agent": UA,
            },
            timeoutMs: 30_000,
          },
        );
        assertBinding(binding);
        let code = "";
        try {
          code = new URL(redirect.url).searchParams.get("code") ?? "";
        } catch {
          /* fallback below */
        }
        if (!code) {
          const match =
            /http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=([^"'>\s]+)/i.exec(
              redirect.body,
            ) ??
            /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/.exec(
              redirect.body,
            );
          if (match?.[1]) {
            try {
              code =
                new URL(match[1], "https://id.scu.edu.cn").searchParams.get(
                  "code",
                ) ?? "";
            } catch {
              /* fail closed */
            }
          }
        }
        if (!code) throw new Error("CCYL authorization response missing code");
        const response = await t.writeOnce(
          "https://dekt.scu.edu.cn/ccyl-api/app/auth/loginByUc",
          {
            method: "POST",
            headers: {
              Accept: "application/json, text/plain, */*",
              "Content-Type": "application/json;charset=UTF-8",
              Origin: "https://dekt.scu.edu.cn",
              Referer: "https://dekt.scu.edu.cn",
              "User-Agent": UA,
            },
            body: JSON.stringify({ code }),
            timeoutMs: 30_000,
          },
        );
        assertBinding(binding);
        if (response.status !== 200) throw new Error("CCYL login HTTP failure");
        const parsed: unknown = JSON.parse(response.body);
        if (
          !record(parsed) ||
          (parsed.code !== 0 && parsed.code !== "0") ||
          !text(parsed.token)
        )
          throw new Error("CCYL login rejected");
        return {
          binding: { ...binding },
          ccylToken: text(parsed.token),
          ccylUserId: record(parsed.user) ? text(parsed.user.id) : "",
        };
      }
      const redirect = await t.request(
        "https://id.scu.edu.cn/enduser/sp/sso/scdxplugin_jwt31?enterpriseId=scdx",
        {
          headers: {
            Accept: "text/html,application/xhtml+xml,*/*",
            "User-Agent": UA,
            ...auth,
          },
          timeoutMs: 30_000,
        },
      );
      assertBinding(binding);
      if (redirect.status === 401 || redirect.status === 403)
        throw new Error("Repair identity login rejected");
      let userinfo = "";
      try {
        userinfo = new URL(redirect.url).searchParams.get("userinfo") ?? "";
      } catch {
        /* fail closed */
      }
      if (!userinfo)
        throw new Error("Repair authorization response missing userinfo");
      const response = await t.writeOnce(
        "https://zhhq.scu.edu.cn/api/auth/login/auto",
        {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Origin: "https://zhhq.scu.edu.cn",
            Referer: "https://zhhq.scu.edu.cn/account/login",
            "User-Agent": UA,
            "X-Requested-With": "XMLHttpRequest",
          },
          body: new URLSearchParams({
            userInfo: encodeURIComponent(userinfo),
            clientId: "web201911chengdu",
            timestamp: encryptTimestamp(),
            schoolCode: "10610",
            schoolName: "四川大学",
          }).toString(),
          timeoutMs: 30_000,
        },
      );
      assertBinding(binding);
      const key = text(repairEnvelope(response).data);
      if (key.length < 16)
        throw new Error("Repair login missing valid tokenKey");
      return { binding: { ...binding }, repairTokenKey: key };
    },
    async request(request, binding) {
      assertBinding(binding);
      if (request.retry !== "never" || request.method !== "POST")
        throw new Error("Only one-shot POST writes are permitted");
      const url = new URL(request.url);
      const allowed =
        (url.origin === "https://zhhq.scu.edu.cn" &&
          [
            "/api/repair/publish/publish",
            "/api/repair/myRepair/withdrawMyRepair",
          ].includes(url.pathname)) ||
        (url.origin === "https://dekt.scu.edu.cn" &&
          (/^\/ccyl-api\/app\/activity\/(sign-up-act|cancel)$/.test(
            url.pathname,
          ) ||
            /^\/ccyl-api\/app\/activity\/(subscribe-act|cancel-subscribe)\/[^/]+$/.test(
              url.pathname,
            )));
      if (!allowed || url.search || url.hash || url.username || url.password)
        throw new Error("Unsupported campus write endpoint");
      const response = await t.writeOnce(request.url, {
        method: "POST",
        headers: { ...request.headers, "User-Agent": UA },
        body: request.body,
        timeoutMs: request.timeoutMs,
      });
      assertBinding(binding);
      return response;
    },
  };
}
