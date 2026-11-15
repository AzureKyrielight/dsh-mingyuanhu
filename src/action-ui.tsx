import { useRef, useState } from "react";
import type { ActionPreview, ActionRemote } from "./action-contracts.js";
import { panelStyles } from "./ui-tokens.js";

export const actionZh = {
  title: "校园操作确认",
  id: "草稿 ID",
  inspect: "查看冻结草稿",
  confirm: "继续：确认此操作",
  submit: "最终确认并提交一次",
  cancel: "返回检查",
  consent: "我已检查下方全部冻结字段，确认对当前校园账号执行此操作。",
  warning:
    "此按钮只确认校园业务操作，不批准任何模型工具。提交后不可重复；结果不明时请先到校园系统人工核对。",
  unavailable:
    "无法读取或提交：草稿可能已过期、已使用、账号已切换或当前不是账号所有者。请先核对校园记录，不要自动重试。",
  unsupported:
    "目前只支持二课报名、取消报名、订阅、取消订阅及报修撤回。报修发布、办事大厅提交、上传、浏览器操作不可用。",
  expires: "到期时间",
  status: "状态",
  succeeded: "已提交成功",
  rejected: "校园服务拒绝了操作",
  unknown: "提交结果不明，请人工核对，勿重试",
  busy: "处理中…",
  payload: "完整冻结操作（不可修改）",
};
export const actionEn: Record<keyof typeof actionZh, string> = {
  title: "Confirm campus action",
  id: "Draft ID",
  inspect: "Inspect frozen draft",
  confirm: "Continue to confirmation",
  submit: "Final confirmation: submit once",
  cancel: "Back to review",
  consent:
    "I have reviewed every frozen field below and authorize this action on the current campus account.",
  warning:
    "This button confirms only this campus action, not any model tool approval. Never repeat a submission; verify campus records manually if the result is unknown.",
  unavailable:
    "Cannot inspect or submit: the draft may be expired, consumed, bound to another login, or you are not the owner. Verify campus records before retrying.",
  unsupported:
    "Only CCYL signup, cancellation, subscription, unsubscription and repair withdrawal are supported. Repair submission, service submission, uploads and browser actions are unavailable.",
  expires: "Expires",
  status: "Status",
  succeeded: "Submission succeeded",
  rejected: "Campus service rejected the action",
  unknown: "Outcome unknown: verify manually; do not retry",
  busy: "Working…",
  payload: "Complete frozen action (read-only)",
};
export type ActionTranslate = (key: keyof typeof actionZh) => string;
/** Exported separately so SSR tests verify full payload escaping, without mocked hooks. */
export function ActionPreviewView({
  preview,
  t,
}: {
  preview: ActionPreview;
  t: ActionTranslate;
}) {
  return (
    <section aria-label={t("payload")}>
      <p>{preview.id}</p>
      <p>
        {t("expires")}: {new Date(preview.expiresAt).toISOString()}
      </p>
      <p>
        {t("status")}: {preview.status}
      </p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify(preview.action, null, 2)}
      </pre>
    </section>
  );
}
export function ActionPanel({
  remote,
  t,
}: {
  remote: ActionRemote;
  t: ActionTranslate;
}) {
  const [id, setId] = useState("");
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<keyof typeof actionZh | null>(null);
  const active = useRef(false);
  async function inspect() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setPreview(null);
    setConfirm(false);
    setConsent(false);
    setMessage(null);
    try {
      const result = await remote.inspect(id.trim());
      if (!result.ok || !result.value.success) setMessage("unavailable");
      else setPreview(result.value.data);
    } catch {
      setMessage("unavailable");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function commit() {
    if (
      active.current ||
      !preview ||
      !confirm ||
      !consent ||
      preview.status !== "prepared" ||
      Date.now() >= preview.expiresAt
    )
      return;
    active.current = true;
    setBusy(true);
    setMessage(null);
    const selected = preview;
    // Disable replay even if the Remote response is lost after a successful campus write.
    setPreview({ ...selected, status: "unknown" });
    setConfirm(false);
    setConsent(false);
    try {
      const result = await remote.commit(selected.id);
      if (!result.ok || !result.value.success) setMessage("unknown");
      else {
        setPreview({ ...selected, status: result.value.data.status });
        setMessage(result.value.data.status);
      }
    } catch {
      setMessage("unknown");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="scu-account" aria-label={t("title")}>
      <style>{panelStyles}</style>
      <h2>{t("title")}</h2>
      <p className="scu-muted">{t("unsupported")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label>
          {t("id")}
          <input
            value={id}
            disabled={busy}
            onChange={(event) => {
              setId(event.target.value);
              setPreview(null);
              setConfirm(false);
              setConsent(false);
            }}
          />
        </label>
        <button type="submit" disabled={busy || !id.trim()}>
          {busy ? t("busy") : t("inspect")}
        </button>
      </form>
      {preview && (
        <>
          <ActionPreviewView preview={preview} t={t} />
          {preview.status === "prepared" && !confirm && (
            <button
              type="button"
              disabled={busy || Date.now() >= preview.expiresAt}
              onClick={() => {
                setConfirm(true);
                setConsent(false);
              }}
            >
              {t("confirm")}
            </button>
          )}
          {confirm && (
            <>
              <p>{t("warning")}</p>
              <label className="scu-check">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {t("consent")}
              </label>
              <div className="scu-row">
                <button
                  type="button"
                  disabled={busy || !consent || Date.now() >= preview.expiresAt}
                  onClick={() => void commit()}
                >
                  {t("submit")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    setConsent(false);
                  }}
                >
                  {t("cancel")}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {message && <p role="alert">{t(message)}</p>}
    </section>
  );
}
