import { createElement } from "react";
import { ACCOUNT_REMOTE, type AccountRemote } from "./contracts.js";
import { AccountPanel, en, zh, type Translate } from "./ui.js";

interface ClientContext {
  remote: {
    $mount(contribution: typeof ACCOUNT_REMOTE): () => void;
    scuAccount: AccountRemote;
  };
  locale: {
    register(
      namespace: string,
      dictionaries: { zh: typeof zh; en: typeof en },
    ): () => void;
    bind(namespace: string): Translate;
  };
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
      component: (props: { t: Translate }) => ReturnType<typeof createElement>,
    ): () => void;
  };
  on(event: string, callback: () => void): () => void;
  effect(callback: () => () => void): void;
}

export const inject = ["remote", "slots", "locale"];
export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.remote.$mount(ACCOUNT_REMOTE));
  ctx.effect(() => ctx.locale.register("mingyuanhu", { zh, en }));
  const t = ctx.locale.bind("mingyuanhu");
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "mingyuanhu",
        order: 70,
        label: () => t("title"),
        locale: "mingyuanhu",
      },
      (props) =>
        createElement(AccountPanel, {
          remote: ctx.remote.scuAccount,
          t: props.t,
        }),
    ),
  );
}
