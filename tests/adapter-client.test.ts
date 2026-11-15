import { describe, expect, it, vi } from "vitest";
import { apply, inject } from "../src/client.js";

describe("native account panel contribution", () => {
  it("declares only services it can obtain before mounting the account namespace", () => {
    expect(inject).toEqual(["remote", "locale"]);
  });

  it("awaits the remote namespace before registering the localized panel", async () => {
    let releaseMount: (() => void) | undefined;
    const mount = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const disposeRemote = vi.fn();
    const disposeLocale = vi.fn();
    const disposeSlot = vi.fn();
    const cleanup: (() => void)[] = [];
    const register = vi.fn(
      (_options: object, _component: unknown) => disposeSlot,
    );
    const plugin = vi.fn(
      (_child: { inject: string[]; apply(ctx: unknown): void }) => undefined,
    );
    const panelContext = {
      remote: { scuAccount: {} },
      slots: {
        inject: (_name: string, callback: () => () => void) => {
          const dispose = callback();
          cleanup.push(dispose);
          return dispose;
        },
        register,
      },
    };
    const pending = apply({
      remote: {
        $mount: vi.fn(async () => {
          await mount;
          return disposeRemote;
        }),
      },
      locale: {
        register: vi.fn(() => disposeLocale),
        bind: () => (key: string) => key,
      },
      effect: (callback: () => () => void) => cleanup.push(callback()),
      plugin: (child: { inject: string[]; apply(ctx: unknown): void }) => {
        plugin(child);
        child.apply(panelContext);
      },
    } as unknown as Parameters<typeof apply>[0]);
    expect(plugin).not.toHaveBeenCalled();
    releaseMount?.();
    await pending;
    expect(plugin.mock.calls[0]?.[0]?.inject).toEqual([
      "remote.scuAccount",
      "slots",
    ]);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      name: "settings.section",
      id: "mingyuanhu",
      locale: "mingyuanhu",
    });
    for (const dispose of cleanup.reverse()) dispose();
    expect(disposeSlot).toHaveBeenCalledOnce();
    expect(disposeLocale).toHaveBeenCalledOnce();
    expect(disposeRemote).toHaveBeenCalledOnce();
  });
});
