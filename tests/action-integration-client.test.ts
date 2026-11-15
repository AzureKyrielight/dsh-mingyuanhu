import { Context, Service } from "@deepseek-ai/cordis";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { apply, inject } from "../src/client.js";

describe("action namespace real Client injection", () => {
  it("mounts namespaces before rendering the actual settings component", async () => {
    const root = new Context();
    const mounts: string[] = [];
    let html = "";
    class Remote extends Service {
      constructor(ctx: Context) {
        super(ctx, "remote");
      }
      async $mount(info: { descriptors: { service: string }[] }) {
        const name = info.descriptors[0].service;
        mounts.push(name);
        const fiber = this.ctx.plugin({
          apply(ctx: Context) {
            ctx.provide(`remote.${name}`, {});
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
      apply(ctx: Context) {
        ctx.provide("locale", {
          register: () => () => {},
          bind: () => (key: string) => key,
        });
        ctx.provide("slots", {
          inject: (_name: string, callback: () => () => void) => callback(),
          register: (_options: unknown, component: () => ReactNode) => {
            // SSR runs the real hooks and property accesses; no React mock.
            html += renderToStaticMarkup(component());
            return () => {};
          },
        });
      },
    });
    try {
      await root.plugin({
        inject,
        apply: (ctx: Context) =>
          apply(ctx as unknown as Parameters<typeof apply>[0]),
      });
      expect(mounts).toContain("scuActions");
      expect(html).toContain("inspect");
      expect(html).toContain("unsupported");
    } finally {
      await root.fiber.dispose();
    }
  });
});
