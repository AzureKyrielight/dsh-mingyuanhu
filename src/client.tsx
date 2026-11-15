import { createElement, Fragment } from "react";
import { ACCOUNT_REMOTE, type AccountRemote } from "./contracts.js";
import { ACTION_REMOTE, type ActionRemote } from "./action-contracts.js";
import { AccountPanel, en, zh, type Translate } from "./ui.js";
import {
  ActionPanel,
  actionEn,
  actionZh,
  type ActionTranslate,
} from "./action-ui.js";

interface PanelContext {
  remote: { scuAccount: AccountRemote; scuActions: ActionRemote };
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
    $mount(
      contribution: typeof ACCOUNT_REMOTE | typeof ACTION_REMOTE,
    ): Promise<() => Promise<void> | void>;
  };
  locale: {
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): () => void;
    bind(namespace: string): (key: string) => string;
  };
  plugin(plugin: { inject: string[]; apply(ctx: PanelContext): void }): unknown;
  effect(callback: () => () => Promise<void> | void): void;
}
export const inject = ["remote", "locale"];
export async function apply(ctx: ClientContext) {
  const disposeAccount = await ctx.remote.$mount(ACCOUNT_REMOTE);
  ctx.effect(() => disposeAccount);
  const disposeActions = await ctx.remote.$mount(ACTION_REMOTE);
  ctx.effect(() => disposeActions);
  ctx.effect(() => ctx.locale.register("mingyuanhu", { zh, en }));
  ctx.effect(() =>
    ctx.locale.register("mingyuanhu-actions", { zh: actionZh, en: actionEn }),
  );
  const t: Translate = ctx.locale.bind("mingyuanhu");
  const actionT: ActionTranslate = ctx.locale.bind("mingyuanhu-actions");
  ctx.plugin({
    inject: ["remote.scuAccount", "remote.scuActions", "slots"],
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
            createElement(
              Fragment,
              null,
              createElement(AccountPanel, {
                remote: panel.remote.scuAccount,
                t,
              }),
              createElement(ActionPanel, {
                remote: panel.remote.scuActions,
                t: actionT,
              }),
            ),
        ),
      );
    },
  });
}
