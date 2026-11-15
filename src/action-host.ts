import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { CampusClient } from "./core/index.js";
import { requireOwner } from "./host.js";
import { ActionDraftStore, type ActionBinding } from "./actions/draft-store.js";
import {
  prepareCcylSignup,
  prepareCcylCancelSignup,
  prepareCcylSubscription,
  prepareRepairWithdraw,
  type CampusAction,
} from "./actions/actions.js";
import { createActionDispatcher } from "./actions/protocol.js";
import { createSessionActionTransport } from "./actions/session-transport.js";
import {
  ACTION_REMOTE,
  draftIdSchema,
  prepareActionSchema,
  type ActionPreview,
  type ActionReply,
  type PreparedAction,
} from "./action-contracts.js";

type Invocation = NonNullable<Context["invocation"]>;
/** Host-only controller. The campus lock surrounds identity refresh AND the entire write. */
export class ActionController {
  private current: ActionBinding | null = null;
  private identity = "";
  private generation = 0;
  private readonly transport;
  private readonly store;
  constructor(
    private readonly campus: Pick<
      CampusClient,
      "withSignal" | "actionIdentity" | "transport"
    >,
  ) {
    this.transport = createSessionActionTransport(
      campus.transport(),
      () => this.current,
    );
    this.store = new ActionDraftStore<CampusAction, Invocation>({
      authorize: (invocation) => {
        requireOwner(invocation);
        return this.current;
      },
      dispatch: createActionDispatcher(this.transport),
    });
  }
  private async refreshBinding(): Promise<ActionBinding> {
    try {
      const identity = await this.campus.actionIdentity();
      if (identity !== this.identity) {
        if (this.current) this.store.invalidateAccount(this.current.accountId);
        this.identity = identity;
        this.current = {
          ownerId: "local-owner",
          accountId: createHash("sha256").update(identity).digest("hex"),
          sessionGeneration: ++this.generation,
        };
      }
      if (!this.current) throw new Error("Campus login required");
      return this.current;
    } catch (error) {
      if (this.current) this.store.invalidateAccount(this.current.accountId);
      this.current = null;
      this.identity = "";
      throw error;
    }
  }
  prepare(input: unknown, signal?: AbortSignal): Promise<PreparedAction> {
    const args = prepareActionSchema.parse(input);
    return this.campus.withSignal(signal, async () => {
      const binding = await this.refreshBinding();
      let action: CampusAction;
      switch (args.kind) {
        case "ccyl.signup":
          action = prepareCcylSignup(args.activityId, args.scoreType);
          break;
        case "ccyl.cancel-signup": {
          // Authentication only; no business write during preparation.
          const session = await this.transport.session(binding, "ccyl");
          action = prepareCcylCancelSignup(
            args.activityId,
            session.ccylUserId ?? "",
          );
          break;
        }
        case "ccyl.subscribe":
        case "ccyl.cancel-subscribe":
          action = prepareCcylSubscription(
            args.libraryId,
            args.kind === "ccyl.cancel-subscribe",
          );
          break;
        case "repair.withdraw":
          action = prepareRepairWithdraw(args.activeId);
          break;
      }
      const draft = this.store.prepare(binding, action);
      return { id: draft.id, summary: action.kind, expiresAt: draft.expiresAt };
    });
  }
  inspect(id: string, invocation: Invocation): Promise<ActionPreview> {
    requireOwner(invocation);
    draftIdSchema.parse(id);
    return this.campus.withSignal(invocation.signal, async () => {
      await this.refreshBinding();
      const { binding: _binding, ...preview } = this.store.inspect(
        id,
        invocation,
      );
      return preview;
    });
  }
  commit(id: string, invocation: Invocation) {
    requireOwner(invocation);
    draftIdSchema.parse(id);
    return this.campus.withSignal(invocation.signal, async () => {
      await this.refreshBinding();
      return this.store.commit(id, invocation);
    });
  }
}
export class ActionService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly actions: ActionController,
  ) {
    super(ctx, "scuActions");
  }
  private async call<T>(
    operation: (invocation: Invocation) => Promise<T>,
  ): Promise<ActionReply<T>> {
    const invocation = this.ctx.invocation;
    requireOwner(invocation);
    try {
      return { success: true, data: await operation(invocation!) };
    } catch {
      return { success: false, code: "unavailable" };
    }
  }
  @Remote inspect(id: string) {
    return this.call((invocation) => this.actions.inspect(id, invocation));
  }
  /** Direct owner button is business consent, NOT approval of an agent tool invocation. */
  @Remote commit(id: string) {
    return this.call((invocation) => this.actions.commit(id, invocation));
  }
}
export function mountActions(
  ctx: Context,
  campus: CampusClient,
): ActionController {
  const actions = new ActionController(campus);
  ctx.typert.register({
    package: ACTION_REMOTE.package,
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: ACTION_REMOTE.descriptors,
  });
  new ActionService(ctx, actions);
  return actions;
}
