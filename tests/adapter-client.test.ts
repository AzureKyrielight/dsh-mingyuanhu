import { describe, expect, it, vi } from "vitest";
import { apply } from "../src/client.js";

describe("native account panel contribution", () => {
  it("mounts one localized settings slot and withdraws owned resources", () => {
    const disposeRemote = vi.fn();
    const disposeLocale = vi.fn();
    const disposeSlot = vi.fn();
    const cleanup: (() => void)[] = [];
    const register = vi.fn(
      (_options: object, _component: unknown) => disposeSlot,
    );
    apply({
      remote: { $mount: vi.fn(() => disposeRemote), scuAccount: {} },
      locale: {
        register: vi.fn(() => disposeLocale),
        bind: () => (key: string) => key,
      },
      effect: (callback: () => () => void) => cleanup.push(callback()),
      slots: {
        inject: (_name: string, callback: () => () => void) => {
          const dispose = callback();
          cleanup.push(dispose);
          return dispose;
        },
        register,
      },
    } as unknown as Parameters<typeof apply>[0]);
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
