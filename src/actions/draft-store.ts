import { randomUUID } from "node:crypto";

export interface ActionBinding {
  readonly ownerId: string;
  readonly accountId: string;
  /** Host-maintained generation; rotate on logout, login and account replacement. */
  readonly sessionGeneration: number;
}
export type DraftStatus =
  "prepared" | "submitting" | "succeeded" | "rejected" | "unknown";
export interface ActionDraft<A> {
  readonly id: string;
  readonly binding: ActionBinding;
  readonly action: A;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: DraftStatus;
}
export type DispatchResult = {
  readonly status: "succeeded" | "rejected";
  readonly message?: string;
};
export type CommitResult =
  DispatchResult | { readonly status: "unknown"; readonly message: string };

/** Only plain JSON can enter a draft: reject accessors, classes, undefined and cycles. */
export function frozenJson<T>(input: T): T {
  const seen = new Set<object>();
  const copy = (value: unknown): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || seen.has(value))
      throw new Error("Draft must contain plain finite JSON");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Draft must contain plain JSON");
    seen.add(value);
    const result: unknown[] | Record<string, unknown> = Array.isArray(value)
      ? []
      : {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        !("value" in descriptor) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw new Error("Unsafe draft property");
      Object.defineProperty(result, key, {
        value: copy(descriptor.value),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    seen.delete(value);
    return Object.freeze(result);
  };
  return copy(input) as T;
}
const sameBinding = (a: ActionBinding, b: ActionBinding) =>
  a.ownerId === b.ownerId &&
  a.accountId === b.accountId &&
  a.sessionGeneration === b.sessionGeneration;

/** DSH-independent Host-only store. Never expose commit or authorize to agent tools.
 * authorize MUST derive binding from authenticated owner Remote context, not JSON arguments.
 * dispatch MUST use the supplied binding's account/session and MUST NOT retry writes.
 */
export class ActionDraftStore<A, OwnerContext = unknown> {
  readonly #drafts = new Map<string, ActionDraft<A>>();
  readonly #now: () => number;
  constructor(
    private readonly options: {
      authorize: (context: OwnerContext) => ActionBinding | null;
      dispatch: (action: A, binding: ActionBinding) => Promise<DispatchResult>;
      now?: () => number;
      ttlMs?: number;
      maxDrafts?: number;
    },
  ) {
    this.#now = options.now ?? Date.now;
  }

  prepare(binding: ActionBinding, action: A): ActionDraft<A> {
    if (
      !binding.ownerId ||
      !binding.accountId ||
      !Number.isSafeInteger(binding.sessionGeneration) ||
      binding.sessionGeneration < 0
    )
      throw new Error("Missing Host account binding");
    const ttl = this.options.ttlMs ?? 300_000;
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new Error("Invalid draft lifetime");
    this.prune();
    if (this.#drafts.size >= (this.options.maxDrafts ?? 100))
      throw new Error("Too many pending drafts");
    const createdAt = this.#now();
    const draft = frozenJson<ActionDraft<A>>({
      id: randomUUID(),
      binding,
      action,
      createdAt,
      expiresAt: createdAt + ttl,
      status: "prepared",
    });
    this.#drafts.set(draft.id, draft);
    return draft;
  }

  /** Owner UI inspection, also checks current account generation. */
  inspect(id: string, context: OwnerContext): ActionDraft<A> {
    const binding = this.options.authorize(context);
    if (!binding) throw new Error("Owner UI authorization required");
    const draft = this.#drafts.get(id);
    if (!draft || !sameBinding(binding, draft.binding))
      throw new Error("Draft not found for this owner/account/session");
    if (this.#now() >= draft.expiresAt) throw new Error("Draft expired");
    return draft;
  }

  /** Accepts only draft ID + trusted Remote context; no payload, confirmed flag or token. */
  async commit(id: string, context: OwnerContext): Promise<CommitResult> {
    const draft = this.inspect(id, context);
    if (draft.status !== "prepared")
      throw new Error("Draft already used; do not retry");
    // Consume synchronously before any await to block races and double clicks.
    this.#drafts.set(
      id,
      frozenJson({ ...draft, status: "submitting" as const }),
    );
    let result: CommitResult;
    try {
      const response = await this.options.dispatch(draft.action, draft.binding);
      result =
        response &&
        (response.status === "succeeded" || response.status === "rejected")
          ? response
          : {
              status: "unknown",
              message:
                "Unrecognized submission result; verify manually, do not retry",
            };
    } catch {
      result = {
        status: "unknown",
        message:
          "Submission outcome unknown; verify campus records manually, do not retry",
      };
    }
    this.#drafts.set(id, frozenJson({ ...draft, status: result.status }));
    return result;
  }

  /** Call on logout/account rotation; submitted drafts are never replayable. */
  invalidateAccount(accountId: string): void {
    for (const [id, draft] of this.#drafts)
      if (draft.binding.accountId === accountId) this.#drafts.delete(id);
  }
  prune(): void {
    for (const [id, draft] of this.#drafts)
      if (this.#now() >= draft.expiresAt) this.#drafts.delete(id);
  }
}
