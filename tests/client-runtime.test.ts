import { Context, Service } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { apply, inject } from "../src/client.js";

describe("client runtime wiring", () => {
  it("starts the panel only after the account namespace exists", async () => {
    const root = new Context();
    let registered = 0;

    class Namespace extends Service {
      constructor(ctx: Context) {
        super(ctx, "remote.scuAccount");
      }
    }

    class Remote extends Service {
      constructor(ctx: Context) {
        super(ctx, "remote");
      }

      async $mount() {
        const fiber = this.ctx.plugin({
          name: "remote.scuAccount",
          apply: (ctx: Context) => {
            new Namespace(ctx);
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
