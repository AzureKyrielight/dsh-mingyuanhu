import { createElement } from "react";
import { ACCOUNT_REMOTE, type AccountRemote } from "./contracts.js";
import { AccountPanel, en, zh, type Translate } from "./ui.js";

interface PanelContext {
  remote: { scuAccount: AccountRemote };
  slots: {
    inject(name: string, callback: () => () => void): () => void;
    register(
      options: {
        name: string;
        id: string;
        order: number;
        label: () => string;
        locale: string;
      },
      component: () => ReturnType<typeof createElement>,
    ): () => void;
  };
}

interface ClientContext {
  remote: {
    $mount(contribution: typeof ACCOUNT_REMOTE): Promise<() => void>;
  };
  locale: {
    register(
      namespace: string,
      dictionaries: { zh: typeof zh; en: typeof en },
    ): () => void;
    bind(namespace: string): Translate;
  };
  effect(callback: () => () => void): void;
  plugin(plugin: {
    inject: string[];
    apply(ctx: PanelContext): void;
  }): unknown;
}

export const inject = ["remote", "locale"];

export async function apply(ctx: ClientContext) {
  const disposeRemote = await ctx.remote.$mount(ACCOUNT_REMOTE);
  ctx.effect(() => () => {
    void disposeRemote();
  });
  ctx.effect(() => ctx.locale.register("mingyuanhu", { zh, en }));
  const t = ctx.locale.bind("mingyuanhu");
  ctx.plugin({
    inject: ["remote.scuAccount", "slots"],
    apply(panel) {
      panel.slots.inject("settings.section", () =>
        panel.slots.register(
          {
            name: "settings.section",
            id: "mingyuanhu",
            order: 70,
            label: () => t("title"),
            locale: "mingyuanhu",
          },
          () =>
            createElement(AccountPanel, {
              remote: panel.remote.scuAccount,
              t,
            }),
        ),
      );
    },
  });
}
