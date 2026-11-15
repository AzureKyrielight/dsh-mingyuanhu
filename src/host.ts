import type { Context } from "@deepseek-ai/cordis";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { CampusClient } from "./core/index.js";
import {
  ACCOUNT_REMOTE,
  type AccountReply,
  type SignInInput,
} from "./contracts.js";

export function credentialStore(ctx: Context) {
  const key = credentialKey("dsh-mingyuanhu", "campus-session");
  return {
    async load() {
      const record = await ctx.credentials.readRecord(key);
      return record?.kind === "grant" ? record.payload : undefined;
    },
    async save(value: unknown) {
      await ctx.credentials.modifyRecord(key, async () => ({
        kind: "grant",
        payload: value,
      }));
    },
    async clear() {
      await ctx.credentials.deleteRecord(key);
    },
  };
}

export function requireOwner(
  invocation: { peer: { principal: { kind: string } } } | undefined,
) {
  if (invocation?.peer.principal.kind !== "owner")
    throw new Error("Owner Remote invocation required");
}

export class AccountService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly campus: CampusClient,
  ) {
    super(ctx, "scuAccount");
  }

  private async call<T>(operation: () => Promise<T>): Promise<AccountReply<T>> {
    requireOwner(this.ctx.invocation);
    try {
      return {
        success: true,
        data: await this.campus.withSignal(
          this.ctx.invocation!.signal,
          operation,
        ),
      };
    } catch (error) {
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "unavailable";
      return {
        success: false,
        code: [
          "network",
          "timeout",
          "invalid_response",
          "auth",
          "captcha",
          "not_bound",
          "invalid_input",
        ].includes(code)
          ? code
          : "unavailable",
      };
    }
  }

  @Remote
  status() {
    return this.call(async () => {
      const { connected, principal, expiresAt } = await this.campus.status();
      return { connected, principal, expiresAt };
    });
  }
  @Remote
  challenge() {
    return this.call(() => this.campus.challenge());
  }
  @Remote
  signIn(input: SignInInput) {
    return this.call(() => this.campus.signIn(input));
  }
  @Remote
  signOut() {
    return this.call(async () => {
      await this.campus.signOut();
      return null;
    });
  }
}

export function mountAccount(ctx: Context, campus: CampusClient) {
  ctx.typert.register({
    package: ACCOUNT_REMOTE.package,
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: ACCOUNT_REMOTE.descriptors,
  });
  return new AccountService(ctx, campus);
}
