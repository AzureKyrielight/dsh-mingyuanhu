import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ActionController, ActionService } from "../src/action-host.js";
import { ACTION_REMOTE, prepareActionSchema } from "../src/action-contracts.js";
import { registerActionTools } from "../src/action-tools.js";
import type { CampusClient } from "../src/core/index.js";

const owner = {
  peer: { principal: { kind: "owner" } },
  signal: new AbortController().signal,
} as NonNullable<Context["invocation"]>;
function fixture() {
  let identity = "generation:account:loginAt";
  let queue: Promise<unknown> = Promise.resolve();
  const writes: string[] = [];
  const transport = {
    bindIdentity: async () => {},
    authorizationHeaders: async () => ({ Authorization: "Bearer secret" }),
    request: async () => ({
      status: 200,
      body: "",
      url: "https://dekt.scu.edu.cn/?code=auth-code",
    }),
    writeOnce: vi.fn(async (url: string) => {
      writes.push(url);
      return {
        status: 200,
        body: JSON.stringify(
          url.includes("loginByUc")
            ? { code: 0, token: "secret-cookie", user: { id: "host-user" } }
            : { code: 0 },
        ),
        url,
      };
    }),
  };
  const campus = {
    actionIdentity: async () => identity,
    transport: () => transport,
    withSignal: <T>(
      signal: AbortSignal | undefined,
      work: () => Promise<T>,
    ) => {
      const task = queue.then(() => {
        signal?.throwIfAborted();
        return work();
      });
      queue = task.catch(() => {});
      return task;
    },
  } as unknown as CampusClient;
  return {
    controller: new ActionController(campus),
    writes,
    transport,
    switchAccount: () =>
      campus.withSignal(undefined, async () => {
        identity = "new-generation:other-account:loginAt";
      }),
  };
}
describe("action integration authority and wire path", () => {
  it("prepares minimal metadata, previews frozen payload and commits only once", async () => {
    const f = fixture();
    const draft = await f.controller.prepare({
      kind: "ccyl.signup",
      activityId: "a",
      scoreType: "2",
    });
    expect(Object.keys(draft).sort()).toEqual(["expiresAt", "id", "summary"]);
    expect(f.writes).toEqual([]);
    const preview = await f.controller.inspect(draft.id, owner);
    expect(preview.action).toEqual({
      kind: "ccyl.signup",
      payload: { activityId: "a", scoreType: "2" },
    });
    expect(JSON.stringify(preview)).not.toMatch(
      /binding|account|cookie|generation/,
    );
    const results = await Promise.allSettled([
      f.controller.commit(draft.id, owner),
      f.controller.commit(draft.id, owner),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.writes.filter((url) => url.endsWith("sign-up-act"))).toHaveLength(
      1,
    );
  });
  it("refuses forged JSON authority, non-owner and switched accounts before writing", async () => {
    const f = fixture();
    expect(
      prepareActionSchema.safeParse({
        kind: "ccyl.signup",
        activityId: "a",
        scoreType: "2",
        confirmed: true,
      }).success,
    ).toBe(false);
    const draft = await f.controller.prepare({
      kind: "ccyl.subscribe",
      libraryId: "l",
    });
    const viewer = {
      ...owner,
      peer: { principal: { kind: "viewer" } },
    } as unknown as typeof owner;
    expect(() => f.controller.commit(draft.id, viewer)).toThrow("Owner");
    await f.switchAccount();
    await expect(f.controller.commit(draft.id, owner)).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });
  it("derives cancel userId from Host authentication, not model input", async () => {
    const f = fixture();
    const draft = await f.controller.prepare({
      kind: "ccyl.cancel-signup",
      activityId: "a",
    });
    expect(
      (await f.controller.inspect(draft.id, owner)).action.payload,
    ).toEqual({ activityId: "a", userId: "host-user" });
    expect(f.writes.every((url) => url.endsWith("loginByUc"))).toBe(true);
    expect(JSON.stringify(draft)).not.toContain("host-user");
  });
  it("registers prepare only and guards actual service invocation context", async () => {
    const f = fixture();
    const registered: { name: string }[] = [];
    registerActionTools(
      {
        tools: { register: (tool: { name: string }) => registered.push(tool) },
      } as unknown as Context,
      f.controller,
    );
    expect(registered.map((t) => t.name)).toEqual(["scu_action_prepare"]);
    expect(ACTION_REMOTE.descriptors.map((d) => d.method)).toEqual([
      "inspect",
      "commit",
    ]);
    const service = Object.create(ActionService.prototype);
    service.ctx = { invocation: { peer: { principal: { kind: "viewer" } } } };
    service.actions = f.controller;
    await expect(
      service.commit({ id: "forged", peer: owner.peer }),
    ).rejects.toThrow("Owner");
    expect(f.writes).toHaveLength(0);
  });
  it("serializes account rotation behind the complete commit and never retries unknown writes", async () => {
    const f = fixture();
    const draft = await f.controller.prepare({
      kind: "ccyl.signup",
      activityId: "a",
      scoreType: "2",
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.transport.writeOnce.getMockImplementation()!;
    f.transport.writeOnce.mockImplementation(async (url) => {
      if (url.endsWith("sign-up-act")) {
        await barrier;
        throw new Error("lost response");
      }
      return original(url);
    });
    const commit = f.controller.commit(draft.id, owner);
    let switched = false;
    const rotation = f.switchAccount().then(() => {
      switched = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(switched).toBe(false);
    release();
    expect((await commit).status).toBe("unknown");
    await rotation;
    expect(
      f.transport.writeOnce.mock.calls.filter(([url]) =>
        url.endsWith("sign-up-act"),
      ),
    ).toHaveLength(1);
    await expect(f.controller.commit(draft.id, owner)).rejects.toThrow();
  });
  it("fails closed for unsupported operations", async () => {
    const f = fixture();
    for (const kind of ["repair.submit", "service.submit", "upload", "browser"])
      expect(() => f.controller.prepare({ kind })).toThrow();
    expect(f.writes).toHaveLength(0);
  });
});
