import { Context, Service } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { apply, inject } from "../src/client.js";

describe("client runtime wiring", () => {
  it("starts the panel only after the account namespace exists", async () => {
    const root = new Context();
    let registered = 0;

    class Namespace extends Service {
      constructor(ctx: Context, name: string) {
        super(ctx, name);
      }
    }

    class Remote extends Service {
      constructor(ctx: Context) {
        super(ctx, "remote");
      }

      async $mount(contribution: { package: string }) {
        const name =
          contribution.package === "dsh-mingyuanhu-actions"
            ? "remote.scuActions"
            : "remote.scuAccount";
        const fiber = this.ctx.plugin({
          name,
          apply: (ctx: Context) => {
            new Namespace(ctx, name);
          },
        });
        await fiber;
        return async () => {
          await fiber.dispose();
        };
      }
    }

    await root.plugin(Remote);
    await root.plugin({
      inject: ["remote"],
      apply: (ctx: Context) => {
        ctx.provide("locale", {
          register: () => () => {},
          bind: () => (key: string) => key,
        });
        ctx.provide("slots", {
          inject: (_name: string, callback: () => () => void) => callback(),
          register: () => {
            registered += 1;
            return () => {};
          },
        });
      },
    });

    await root.plugin({
      inject,
      apply: (ctx: Context) =>
        apply(ctx as unknown as Parameters<typeof apply>[0]),
    });
    expect(registered).toBe(1);
    await root.fiber.dispose();
  });
});
