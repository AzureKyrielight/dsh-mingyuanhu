import { describe, expect, it, vi } from "vitest";
import {
  ActionDraftStore,
  type ActionBinding,
} from "../src/actions/draft-store";
import {
  prepareCcylSignup,
  prepareCcylCancelSignup,
  prepareCcylSubscription,
  prepareRepairSubmit,
  prepareRepairWithdraw,
  prepareServiceSubmit,
  type CampusAction,
} from "../src/actions/actions";
import {
  createActionDispatcher,
  type WriteRequest,
} from "../src/actions/protocol";
const binding: ActionBinding = {
  ownerId: "owner",
  accountId: "account",
  sessionGeneration: 1,
};
function harness(ttlMs = 100) {
  let now = 0;
  let current = binding;
  const ownerContext = {}; // identity held only by authenticated Host Remote
  const dispatch = vi.fn(async () => ({ status: "succeeded" as const }));
  const store = new ActionDraftStore<CampusAction>({
    dispatch,
    authorize: (context) => (context === ownerContext ? current : null),
    now: () => now,
    ttlMs,
  });
  return {
    store,
    dispatch,
    ownerContext,
    time: (v: number) => {
      now = v;
    },
    account: (v: ActionBinding) => {
      current = v;
    },
  };
}
describe("one-shot owner-bound action drafts", () => {
  it("confirmed:true and guessed owner fields never authorize submission", async () => {
    const h = harness();
    const d = h.store.prepare(binding, prepareCcylSignup("a", "score"));
    await expect(
      h.store.commit(d.id, { confirmed: true, ...binding }),
    ).rejects.toThrow("Owner UI");
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("expires at boundary and rejects cross account, owner and session", async () => {
    const h = harness();
    const d = h.store.prepare(binding, prepareCcylSignup("a", "score"));
    for (const next of [
      { ...binding, accountId: "other" },
      { ...binding, ownerId: "other" },
      { ...binding, sessionGeneration: 2 },
    ]) {
      h.account(next);
      await expect(h.store.commit(d.id, h.ownerContext)).rejects.toThrow(
        "owner/account/session",
      );
    }
    h.account(binding);
    h.time(100);
    await expect(h.store.commit(d.id, h.ownerContext)).rejects.toThrow(
      "expired",
    );
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("freezes a detached payload and dispatches exactly the displayed payload once", async () => {
    const h = harness();
    const action: CampusAction = {
      kind: "ccyl.signup",
      payload: { activityId: "original", scoreType: "score" },
    };
    const d = h.store.prepare(binding, action);
    action.payload.activityId = "changed";
    expect(() => {
      (d.action as typeof action).payload.activityId = "UI tamper";
    }).toThrow();
    expect(await h.store.commit(d.id, h.ownerContext)).toEqual({
      status: "succeeded",
    });
    expect(h.dispatch).toHaveBeenCalledWith(d.action, d.binding);
    expect((d.action as typeof action).payload.activityId).toBe("original");
    await expect(h.store.commit(d.id, h.ownerContext)).rejects.toThrow(
      "already used",
    );
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it("consumes before await and never retries unknown outcomes", async () => {
    const h = harness();
    h.dispatch.mockImplementation(async () => {
      throw new Error("timeout");
    });
    const d = h.store.prepare(binding, prepareRepairWithdraw("active-id"));
    const result = h.store.commit(d.id, h.ownerContext);
    await expect(h.store.commit(d.id, h.ownerContext)).rejects.toThrow(
      "already used",
    );
    expect((await result).status).toBe("unknown");
    await expect(h.store.commit(d.id, h.ownerContext)).rejects.toThrow(
      "already used",
    );
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it("invalidates logout drafts and rejects non-JSON/accessors", () => {
    const h = harness();
    const d = h.store.prepare(binding, prepareRepairWithdraw("id"));
    h.store.invalidateAccount(binding.accountId);
    expect(() => h.store.inspect(d.id, h.ownerContext)).toThrow();
    expect(() =>
      h.store.prepare(binding, {
        get kind() {
          throw new Error("must not invoke getter");
        },
      } as unknown as CampusAction),
    ).toThrow("Unsafe");
  });
});
describe("real protocol adapter with injected transport only", () => {
  function adapter(body = '{"code":0}') {
    const request = vi.fn(async (_request: WriteRequest) => ({
      status: 200,
      body,
    }));
    return {
      request,
      dispatch: createActionDispatcher({
        request,
        session: async () => ({
          binding,
          ccylToken: "test-token",
          ccylUserId: "me",
          repairTokenKey: "test-repair-token",
        }),
      }),
    };
  }
  it("uses exact CCYL sign-up/cancel bodies and encoded subscription path", async () => {
    const a = adapter();
    await a.dispatch(prepareCcylSignup("act", "score"), binding);
    expect(a.request.mock.calls[0][0]).toMatchObject({
      url: "https://dekt.scu.edu.cn/ccyl-api/app/activity/sign-up-act",
      body: '{"activityId":"act","scoreType":"score"}',
      retry: "never",
    });
    await a.dispatch(prepareCcylCancelSignup("act", "me"), binding);
    expect(a.request.mock.calls[1][0].body).toBe(
      '{"activityId":"act","userId":"me"}',
    );
    await a.dispatch(prepareCcylSubscription("lib/a", true), binding);
    expect(a.request.mock.calls[2][0].url).toContain(
      "/cancel-subscribe/lib%2Fa",
    );
    await expect(
      a.dispatch(prepareCcylCancelSignup("act", "other"), binding),
    ).rejects.toThrow("user changed");
    expect(a.request).toHaveBeenCalledTimes(3);
  });
  it("uses repair activeId, rejects paths and constructs exact publish fields", async () => {
    const a = adapter("invalid encrypted response");
    await expect(
      a.dispatch(prepareRepairWithdraw("active id"), binding),
    ).rejects.toThrow();
    expect(a.request.mock.calls[0][0]).toMatchObject({
      url: "https://zhhq.scu.edu.cn/api/repair/myRepair/withdrawMyRepair",
      body: "id=active+id",
    });
    const ctx = {
      address: {
        id: "1",
        areaId: "area",
        areaName: "区域",
        addressDetail: "门牌",
        phone: "123",
      },
      project: { value: "leaf", label: "大类/叶子" },
    };
    expect(() =>
      prepareRepairSubmit({ content: "test", images: ["C:\\secret.txt"] }, ctx),
    ).toThrow("uploads");
    const action = prepareRepairSubmit(
      { content: "故障", allowAbsent: true },
      ctx,
    );
    expect(action.payload).toMatchObject({
      projectId: "leaf",
      projectName: "大类/叶子",
      ifOnduty: "1",
      resourcesVOS: [],
      ifRecord: 0,
    });
  });
  it("serializes only schema-defined service fields and refuses complex forms", async () => {
    const schema = {
      appId: "app",
      formId: "form",
      formVersionId: "version",
      auth: { input_1: "require" },
      data: {},
      fields: [
        {
          key: "input_1",
          type: "input",
          required: true,
          readOnly: false,
          suppressed: false,
          options: [],
        },
      ],
    };
    const action = prepareServiceSubmit(schema, "department", {
      input_1: "hello",
    });
    const a = adapter('{"e":0}');
    await expect(a.dispatch(action, binding)).resolves.toEqual({
      status: "succeeded",
    });
    const form = new URLSearchParams(a.request.mock.calls[0][0].body);
    expect(JSON.parse(form.get("data")!)).toEqual({
      app_id: "app",
      node_id: "",
      form_data: { form: { input_1: "hello" } },
      userview: 1,
    });
    expect(form.get("starter_depart_id")).toBe("department");
    expect(() =>
      prepareServiceSubmit(schema, "department", { unknown: "x" }),
    ).toThrow("Unknown");
    expect(() =>
      prepareServiceSubmit(
        { ...schema, fields: [{ ...schema.fields[0], type: "dataSource" }] },
        "department",
        {},
      ),
    ).toThrow("Unsupported");
    expect(() => prepareServiceSubmit(schema, "department", {})).toThrow(
      "Required",
    );
  });
  it("never reports malformed response as success or replays it", async () => {
    const a = adapter("{}");
    await expect(
      a.dispatch(prepareCcylSignup("a", "s"), binding),
    ).rejects.toThrow("Unrecognized");
    expect(a.request).toHaveBeenCalledTimes(1);
  });
});
