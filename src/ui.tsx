import { useEffect, useState, type FormEvent } from "react";
import type {
  AccountRemote,
  AccountStatus,
  Challenge,
  SignInInput,
} from "./contracts.js";
import { panelStyles } from "./ui-tokens.js";

export const zh = {
  title: "明远湖光",
  subtitle: "四川大学校园账号",
  username: "学号 / 用户名",
  password: "密码",
  auto: "自动识别验证码",
  manual: "手动输入验证码",
  captcha: "验证码",
  refresh: "获取验证码",
  remember: "记住校园会话",
  privacy:
    "密码不保存，也不会发送到聊天记录。查询结果会发送给模型。记住会话会保存登录票据；同一系统用户下的本机工具不受隔离。",
  login: "登录",
  logout: "退出登录",
  confirm: "确认退出",
  cancel: "取消",
  confirmText: "退出并清除保存的校园会话？",
  connected: "已登录",
  disconnected: "未登录",
  loading: "处理中…",
  unavailable: "暂时无法连接校园服务，请稍后重试。",
  auth: "登录失败，请检查账号和密码。",
  captchaError: "验证码识别失败，请切换手动输入或刷新验证码。",
  forbidden: "仅账号所有者可以操作校园登录。",
  timeout: "校园服务响应超时，请重试。",
  invalid: "请检查输入后重试。",
  notBound: "此账号没有绑定可查询的房间。",
  refreshStatus: "刷新状态",
};
export const en: Record<keyof typeof zh, string> = {
  title: "MingYuanHu",
  subtitle: "Sichuan University account",
  username: "Student ID / Username",
  password: "Password",
  auto: "Automatic CAPTCHA",
  manual: "Manual CAPTCHA",
  captcha: "CAPTCHA",
  refresh: "Get CAPTCHA",
  remember: "Remember campus session",
  privacy:
    "Your password is not stored or sent to chat history. Query results are sent to the model. Remembering the session stores login tokens; local tools running as the same OS user are not isolated.",
  login: "Sign in",
  logout: "Sign out",
  confirm: "Confirm sign out",
  cancel: "Cancel",
  confirmText: "Sign out and remove the saved campus session?",
  connected: "Signed in",
  disconnected: "Not signed in",
  loading: "Working…",
  unavailable: "Campus services are unavailable. Try again later.",
  auth: "Sign-in failed. Check your username and password.",
  captchaError:
    "CAPTCHA recognition failed. Enter it manually or get a new CAPTCHA.",
  forbidden: "Only the account owner can manage campus sign-in.",
  timeout: "Campus services timed out. Try again.",
  invalid: "Check your input and try again.",
  notBound: "No queryable room is bound to this account.",
  refreshStatus: "Refresh status",
};
export type Translate = (key: keyof typeof zh) => string;

export function AccountPanel({
  remote,
  t,
}: {
  remote: AccountRemote;
  t: Translate;
}) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<keyof typeof zh | null>(null);
  const [confirm, setConfirm] = useState(false);
  const errorKey = (code: string): keyof typeof zh => {
    const keys: Record<string, keyof typeof zh> = {
      auth: "auth",
      captcha: "captchaError",
      timeout: "timeout",
      invalid_input: "invalid",
      not_bound: "notBound",
    };
    return keys[code] ?? "unavailable";
  };

  useEffect(() => {
    let active = true;
    void remote
      .status()
      .then((result) => {
        if (!active) return;
        if (!result.ok) setError("unavailable");
        else if (!result.value.success) setError(errorKey(result.value.code));
        else setStatus(result.value.data);
      })
      .catch(() => {
        if (active) setError("unavailable");
      });
    return () => {
      active = false;
    };
  }, [remote]);

  async function refreshStatus() {
    setBusy(true);
    setError(null);
    try {
      const result = await remote.status();
      if (!result.ok) setError("unavailable");
      else if (!result.value.success) setError(errorKey(result.value.code));
      else setStatus(result.value.data);
    } catch {
      setError("unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function getChallenge() {
    setBusy(true);
    setError(null);
    setChallenge(null);
    try {
      const result = await remote.challenge();
      if (!result.ok) setError("unavailable");
      else if (!result.value.success) setError(errorKey(result.value.code));
      else setChallenge(result.value.data);
    } catch {
      setError("unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    if (mode === "manual" && !challenge) {
      setError("captchaError");
      return;
    }
    const input: SignInInput = {
      username: String(fields.get("username") ?? ""),
      password: String(fields.get("password") ?? ""),
      rememberSession: fields.get("remember") === "on",
      captcha:
        mode === "auto"
          ? { mode: "auto" }
          : {
              mode: "manual",
              challengeId: challenge!.challengeId,
              text: String(fields.get("captcha") ?? ""),
            },
    };
    setBusy(true);
    setError(null);
    try {
      const result = await remote.signIn(input);
      if (!result.ok) setError("unavailable");
      else if (!result.value.success) setError(errorKey(result.value.code));
      else {
        setStatus(result.value.data);
        setChallenge(null);
        form.reset();
      }
    } catch {
      setError("unavailable");
    } finally {
      input.password = "";
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      const result = await remote.signOut();
      if (!result.ok) setError("unavailable");
      else if (!result.value.success) setError(errorKey(result.value.code));
      else {
        setStatus({ connected: false, principal: null, expiresAt: null });
        setConfirm(false);
      }
    } catch {
      setError("unavailable");
    } finally {
      setBusy(false);
    }
  }
  const image = challenge?.image.startsWith("data:image/")
    ? challenge.image
    : challenge
      ? `data:image/png;base64,${challenge.image}`
      : undefined;
  return (
    <section className="scu-account" aria-busy={busy}>
      <style>{panelStyles}</style>
      <h2>{t("title")}</h2>
      <p className="scu-muted">{t("subtitle")}</p>
      <p role="status">
        {status
          ? t(status.connected ? "connected" : "disconnected")
          : t("loading")}
        {status?.principal ? ` · ${status.principal}` : ""}
      </p>
      {error && <p role="alert">{t(error)}</p>}
      {status?.connected ? (
        <div className="scu-row">
          {confirm ? (
            <>
              <p>{t("confirmText")}</p>
              <button disabled={busy} onClick={() => void signOut()}>
                {t("confirm")}
              </button>
              <button disabled={busy} onClick={() => setConfirm(false)}>
                {t("cancel")}
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={() => setConfirm(true)}>
              {t("logout")}
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={(event) => void signIn(event)}>
          <label>
            {t("username")}
            <input
              name="username"
              autoComplete="username"
              required
              disabled={busy}
              maxLength={128}
            />
          </label>
          <label>
            {t("password")}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
              maxLength={1024}
            />
          </label>
          <select
            aria-label={t("captcha")}
            value={mode}
            disabled={busy}
            onChange={(event) => {
              setMode(
                event.currentTarget.value === "manual" ? "manual" : "auto",
              );
              setChallenge(null);
            }}
          >
            <option value="auto">{t("auto")}</option>
            <option value="manual">{t("manual")}</option>
          </select>
          {mode === "manual" && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void getChallenge()}
              >
                {t("refresh")}
              </button>
              {image && <img src={image} alt={t("captcha")} />}
              <label>
                {t("captcha")}
                <input
                  name="captcha"
                  autoComplete="off"
                  required
                  disabled={busy || !challenge}
                  maxLength={32}
                />
              </label>
            </>
          )}
          <label className="scu-check">
            <input name="remember" type="checkbox" disabled={busy} />
            {t("remember")}
          </label>
          <p className="scu-muted">{t("privacy")}</p>
          <button disabled={busy || (mode === "manual" && !challenge)}>
            {t(busy ? "loading" : "login")}
          </button>
        </form>
      )}
      <div>
        <button disabled={busy} onClick={() => void refreshStatus()}>
          {t("refreshStatus")}
        </button>
      </div>
    </section>
  );
}
