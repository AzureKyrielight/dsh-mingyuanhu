import { describe, expect, it } from "vitest";
import { sm2 } from "sm-crypto";
import { CampusClient, CampusError } from "../src/core/index";

function json(
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("CampusClient protocol boundaries", () => {
  it("rejects non-campus redirect targets", async () => {
    const fetcher = async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example/" },
      });
    await expect(
      new CampusClient({ fetch: fetcher }).challenge(),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("performs SM2 login using publicKey and never sends plaintext password", async () => {
    const keys = sm2.generateKeyPairHex();
    const seen: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      const url = request.url;
      if (url.includes("one_time_login/captcha"))
        return json({ data: { captcha: "not-a-real-png", code: "cap-code" } });
      if (url.endsWith("/sm2_key"))
        return json({
          data: {
            publicKey: Buffer.from(keys.publicKey, "hex").toString("base64"),
            code: "sm2-code",
          },
        });
      if (url.endsWith("/rest_token")) {
        const body = JSON.parse(await request.text()) as {
          password: string;
          username: string;
          sm2_code: string;
        };
        expect(body.username).toBe("20201234");
        expect(body.sm2_code).toBe("sm2-code");
        expect(body.password).not.toBe("plain-password");
        expect(body.password).not.toContain("plain-password");
        const encrypted = Buffer.from(body.password, "base64")
          .subarray(1)
          .toString("hex");
        expect(encrypted.length).toBeGreaterThan(64);
        expect(sm2.doDecrypt(encrypted, keys.privateKey, 0)).toBe(
          "plain-password",
        );
        return json({ success: true, data: { access_token: "token-1" } });
      }
      throw new Error(`unexpected ${url}`);
    };
    const client = new CampusClient({ fetch: fetcher });
    const challenge = await client.challenge();
    const state = await client.signIn({
      username: "20201234",
      password: "plain-password",
      captcha: {
        mode: "manual",
        challengeId: challenge.challengeId,
        text: "abcd",
      },
      rememberSession: false,
    });
    expect(state.connected).toBe(true);
    expect(seen.some((request) => request.url.endsWith("/rest_token"))).toBe(
      true,
    );
  });

  it("follows SSO and strips Authorization after origin changes", async () => {
    const calls: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url.includes("session/save")) return json({ success: true });
      if (request.url.includes("jwt23"))
        return new Response("", {
          status: 302,
          headers: { location: "http://zhjw.scu.edu.cn/" },
        });
      if (
        request.url === "http://zhjw.scu.edu.cn/" ||
        request.url.endsWith("/calendarSemesterCurriculum/index")
      )
        return new Response('<option value="2025-2026-2-1">学期</option>');
      throw new Error(request.url);
    };
    const store = {
      load: async () => ({
        token: "t",
        username: "20201234",
        loginAt: Date.now(),
      }),
      save: async () => {},
      clear: async () => {},
    };
    const client = new CampusClient({ fetch: fetcher, store });
    await client.semesters();
    const relay = calls.find((request) => request.url.includes("jwt23"));
    expect(relay?.headers.get("authorization")).toBe("Bearer t");
    const destination = calls.find(
      (request) => request.url === "http://zhjw.scu.edu.cn/",
    );
    expect(destination?.headers.get("authorization")).toBeNull();
  });

  it("returns only pay data for a successful bound-room response", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.includes("session/save")) return json({ success: true });
      if (request.url.includes("get-info"))
        return json({
          e: 0,
          d: { base: { realname: "学生", role: { number: "20201234" } } },
        });
      if (request.url.includes("airWarrant"))
        return new Response("", { status: 200 });
      if (request.url.includes("queryRoomInfo"))
        return json({ respCode: "00", data: { balance: 12.5 } });
      throw new Error(request.url);
    };
    const store = {
      load: async () => ({
        token: "t",
        username: "20201234",
        loginAt: Date.now(),
      }),
      save: async () => {},
      clear: async () => {},
    };
    await expect(
      new CampusClient({ fetch: fetcher, store }).balance({ type: 1 }),
    ).resolves.toEqual({ balance: 12.5 });
  });

  it("maps failed pay responses to a safe CampusError", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.includes("session/save")) return json({ success: true });
      if (request.url.includes("get-info"))
        return json({
          e: 0,
          d: { base: { realname: "学生", role: { number: "20201234" } } },
        });
      if (request.url.includes("airWarrant"))
        return new Response("", { status: 200 });
      if (request.url.includes("queryRoomInfo"))
        return json({ respCode: "01", respDesc: "未绑定房间" });
      throw new Error(request.url);
    };
    const store = {
      load: async () => ({
        token: "t",
        username: "20201234",
        loginAt: Date.now(),
      }),
      save: async () => {},
      clear: async () => {},
    };
    await expect(
      new CampusClient({ fetch: fetcher, store }).balance({ type: 1 }),
    ).rejects.toMatchObject({ code: "not_bound" });
  });

  it("does not persist or restore after signOut", async () => {
    let clears = 0;
    const store = {
      load: async () => ({
        token: "t",
        username: "20201234",
        loginAt: Date.now(),
      }),
      save: async () => {},
      clear: async () => {
        clears += 1;
      },
    };
    const client = new CampusClient({ store });
    await client.signOut();
    expect(clears).toBe(1);
    expect((await client.status()).connected).toBe(false);
  });

  it("maps abort to timeout", async () => {
    const controller = new AbortController();
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      throw new DOMException("cancelled", "AbortError");
    };
    controller.abort();
    await expect(
      new CampusClient({
        fetch: fetcher,
        signal: controller.signal,
      }).challenge(),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("requires authentication before balance", async () => {
    await expect(
      new CampusClient().balance({ type: 1 }),
    ).rejects.toBeInstanceOf(CampusError);
  });
});
