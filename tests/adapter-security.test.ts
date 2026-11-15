import { describe, expect, it, vi } from "vitest";
import { AccountService, requireOwner, credentialStore } from "../src/host.js";
import { ACCOUNT_REMOTE, signInSchema } from "../src/contracts.js";
import { registerCampusTools } from "../src/tools.js";
import type { Context } from "@deepseek-ai/cordis";
import type { CampusClient } from "../src/core/index.js";

describe("campus adapter authority boundary", () => {
  it("accepts only an explicit owner Remote invocation", () => {
    expect(() => requireOwner(undefined)).toThrow();
    expect(() =>
      requireOwner({ peer: { principal: { kind: "viewer" } } }),
    ).toThrow();
    expect(() =>
      requireOwner({ peer: { principal: { kind: "owner" } } }),
    ).not.toThrow();
  });
  it("rejects non-owner sign-in before the core sees credentials", async () => {
    const signIn = vi.fn();
    const service = Object.create(AccountService.prototype);
    service.ctx = { invocation: { peer: { principal: { kind: "viewer" } } } };
    service.campus = { signIn };
    await expect(
      service.signIn({
        username: "u",
        password: "secret",
        rememberSession: false,
        captcha: { mode: "auto" },
      }),
    ).rejects.toThrow();
    expect(signIn).not.toHaveBeenCalled();
  });
  it("publishes login only as strict Remote endpoints, never model tools", () => {
    expect(ACCOUNT_REMOTE.descriptors.map((item) => item.method)).toEqual([
      "status",
      "challenge",
      "signIn",
      "signOut",
    ]);
    const registered: { name: string; parameters: object }[] = [];
    const ctx = {
      tools: {
        register: (tool: { name: string; parameters: object }) =>
          registered.push(tool),
      },
    } as unknown as Context;
    registerCampusTools(ctx, {} as CampusClient);
    expect(registered.map((tool) => tool.name)).toEqual([
      "scu_status",
      "scu_semesters",
      "scu_grades",
      "scu_schedule",
      "scu_balance",
    ]);
    expect(JSON.stringify(registered)).not.toMatch(
      /password|username|signIn|challengeId/,
    );
    expect(
      signInSchema.safeParse({
        username: "u",
        password: "p",
        rememberSession: false,
        captcha: { mode: "auto" },
        sessionId: "log",
      }).success,
    ).toBe(false);
  });
  it("passes cancellation and only the balance type to the core", async () => {
    const tools = new Map<
      string,
      { execute(args: object, exec: { signal: AbortSignal }): Promise<unknown> }
    >();
    const signal = new AbortController().signal;
    const campus = {
      withSignal: vi.fn(
        async (_signal: AbortSignal, operation: () => Promise<unknown>) =>
          operation(),
      ),
      balance: vi.fn(async () => ({ balance: 1 })),
    };
    registerCampusTools(
      {
        tools: {
          register: (tool: {
            name: string;
            execute(
              args: object,
              exec: { signal: AbortSignal },
            ): Promise<unknown>;
          }) => tools.set(tool.name, tool),
        },
      } as unknown as Context,
      campus as unknown as CampusClient,
    );
    expect(
      await tools
        .get("scu_balance")!
        .execute(
          { action: "balance", type: 1, schoolCode: "ignored" },
          { signal },
        ),
    ).toEqual({ balance: 1 });
    expect(campus.balance).toHaveBeenCalledWith({ type: 1 });
    expect(campus.withSignal).toHaveBeenCalledWith(
      signal,
      expect.any(Function),
    );
  });
  it("projects only declared safe fields across the Remote result boundary", () => {
    const status = ACCOUNT_REMOTE.descriptors.find(
      (item) => item.method === "status",
    )!;
    if (status.result.mode !== "strict")
      throw new Error("Strict result required");
    expect(
      status.result.encode!(
        {
          success: true,
          data: {
            connected: true,
            principal: "12****34",
            expiresAt: null,
            token: "secret",
          },
          password: "secret",
        },
        () => null,
      ),
    ).toEqual({
      success: true,
      data: { connected: true, principal: "12****34", expiresAt: null },
    });
  });
  it("persists session payloads only in the owned credential record", async () => {
    const credentials = {
      readRecord: vi.fn(async () => ({
        kind: "grant",
        payload: { token: "secret" },
      })),
      modifyRecord: vi.fn(),
      deleteRecord: vi.fn(),
    };
    const store = credentialStore({ credentials } as unknown as Context);
    expect(await store.load()).toEqual({ token: "secret" });
    await store.save({ token: "next" });
    const [key, mutate] = credentials.modifyRecord.mock.calls[0] as unknown as [
      string,
      () => Promise<unknown>,
    ];
    expect(key).toBe("dsh-mingyuanhu/campus-session");
    expect(await mutate()).toEqual({
      kind: "grant",
      payload: { token: "next" },
    });
    await store.clear();
    expect(credentials.deleteRecord).toHaveBeenCalledWith(key);
  });
});
