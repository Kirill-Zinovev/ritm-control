import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { RitmBackdrop } from "./RitmBackdrop";
import { clearManagerSession, saveManagerSession } from "./managerSession";
import { Button, Field, Modal, Notice } from "./ui";

type Runtime = {
  mode: "cloud";
  authenticated: boolean;
  authorized: boolean;
  role: "owner" | "manager" | null;
  displayName: string | null;
  username: string | null;
  mustChangePin: boolean;
};
type AuthContextValue = {
  mode: "cloud" | "local";
  role: "owner" | "manager" | "local" | null;
  displayName: string | null;
  username: string | null;
  signOut: () => Promise<void>;
  openPinChange: () => void;
};
const AuthContext = createContext<AuthContextValue>({
  mode: "local", role: "local", displayName: null, username: null,
  signOut: async () => {}, openPinChange: () => {},
});

async function readRuntime(): Promise<Runtime | "local"> {
  const response = await fetch("/api/runtime", { cache: "no-store", credentials: "same-origin" });
  if (!response.headers.get("content-type")?.includes("application/json")) return "local";
  const value = await response.json();
  if (value?.mode !== "cloud") throw new Error(value?.message || "Не удалось проверить доступ к RITM.");
  return value as Runtime;
}

async function postAuth(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw new Error(value?.message || "Не удалось выполнить действие.");
  return value;
}

export function useCloudAuth() {
  return useContext(AuthContext);
}

export function CloudAuthGate({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<Runtime | "local" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pinChangeOpen, setPinChangeOpen] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) { setLoading(true); setError(""); }
    try {
      setRuntime(await readRuntime());
    } catch (reason) {
      setRuntime(null);
      setError(reason instanceof Error ? reason.message : "RITM временно недоступен.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (runtime === "local" || !runtime?.authorized) return;
    const timer = window.setInterval(() => { void refresh(true); }, 60_000);
    return () => window.clearInterval(timer);
  }, [runtime, refresh]);

  const signOut = useCallback(async () => {
    try { await postAuth("/api/auth/logout"); } finally { clearManagerSession(); location.assign("/?page=supplies"); }
  }, []);
  const openPinChange = useCallback(() => setPinChangeOpen(true), []);

  if (loading || runtime === null) return <AuthFrame><div className="ritm-auth-card"><span className="ritm-auth-mark">RITM<span>/</span></span><p>{error || "Проверяю доступ…"}</p>{error && <Button kind="primary" onClick={() => void refresh()}>Повторить</Button>}</div></AuthFrame>;
  if (runtime === "local") return <AuthContext.Provider value={{ mode: "local", role: "local", displayName: null, username: null, signOut: async () => {}, openPinChange: () => {} }}>{children}</AuthContext.Provider>;
  if (!runtime.authorized || !runtime.role) return <AuthFrame>
    <LoginCard onSuccess={async () => {
      const next = await readRuntime();
      if (next === "local" || !next.authorized || !next.role)
        throw new Error("PIN принят, но браузер не сохранил сессию RITM. Разрешите хранение данных сайта и попробуйте снова.");
      setRuntime(next);
      setError("");
    }} />
  </AuthFrame>;
  if (runtime.mustChangePin) return <AuthFrame>
    <PinForm forced onClose={() => {}} onSaved={() => void refresh()} />
  </AuthFrame>;

  const value: AuthContextValue = {
    mode: "cloud", role: runtime.role, displayName: runtime.displayName,
    username: runtime.username, signOut, openPinChange,
  };
  return <AuthContext.Provider value={value}>
    {children}
    {pinChangeOpen && <Modal open onClose={() => setPinChangeOpen(false)} title="Сменить PIN" description="Используйте личный PIN, который знаете только вы.">
      <PinForm forced={false} onClose={() => setPinChangeOpen(false)} onSaved={() => { setPinChangeOpen(false); void refresh(); }} />
    </Modal>}
  </AuthContext.Provider>;
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <div className="ritm-auth-screen"><RitmBackdrop /><div className="ritm-auth-frame">{children}</div></div>;
}

function LoginCard({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await postAuth("/api/auth/login", { username, pin });
      if (typeof result.sessionToken === "string") saveManagerSession(result.sessionToken);
      await onSuccess();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось войти."); }
    finally { setBusy(false); }
  };
  return <section className="ritm-auth-card">
    <span className="ritm-auth-mark">RITM<span>/</span></span>
    <p className="ritm-auth-eyebrow">Рабочее пространство</p>
    <h1>Вход в RITM</h1>
    <p className="ritm-auth-copy">Введите логин и PIN, выданные руководителем. ChatGPT для входа не нужен.</p>
    <form onSubmit={submit}>
      <Field label="Логин"><input autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} maxLength={40} /></Field>
      <Field label="PIN из 8 цифр"><input type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} maxLength={8} pattern="\d{8}" /></Field>
      {error && <Notice tone="warning">{error}</Notice>}
      <Button kind="primary" type="submit" disabled={busy || username.trim().length < 3 || pin.length !== 8}>{busy ? "Проверяю…" : "Войти"}</Button>
    </form>
    <small className="ritm-auth-footnote">Если PIN не подходит, попросите руководителя сбросить его.</small>
  </section>;
}

function PinForm({ forced, onClose, onSaved }: { forced: boolean; onClose: () => void; onSaved: () => void }) {
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    if (newPin !== confirmPin) { setError("PIN-коды не совпадают."); return; }
    setBusy(true);
    try { await postAuth("/api/auth/change-pin", { currentPin: forced ? undefined : currentPin, newPin }); onSaved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить PIN."); }
    finally { setBusy(false); }
  };
  return <div className={forced ? "ritm-auth-card" : "ritm-pin-change"}>
    {forced && <><span className="ritm-auth-mark">RITM<span>/</span></span><p className="ritm-auth-eyebrow">Первый вход</p><h1>Задайте личный PIN</h1><p className="ritm-auth-copy">Временный PIN больше не будет действовать после сохранения нового.</p></>}
    <form onSubmit={submit}>
      {!forced && <Field label="Текущий PIN"><input type="password" inputMode="numeric" value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 8))} maxLength={8} /></Field>}
      <Field label="Новый PIN · 8 цифр"><input type="password" inputMode="numeric" autoComplete="new-password" value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 8))} maxLength={8} pattern="\d{8}" /></Field>
      <Field label="Повторите новый PIN"><input type="password" inputMode="numeric" autoComplete="new-password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 8))} maxLength={8} pattern="\d{8}" /></Field>
      {error && <Notice tone="warning">{error}</Notice>}
      <div className="ritm-auth-actions"><Button type="button" onClick={onClose} disabled={forced}>Отмена</Button><Button kind="primary" type="submit" disabled={busy || newPin.length !== 8 || confirmPin.length !== 8 || (!forced && currentPin.length !== 8)}>{busy ? "Сохраняю…" : "Сохранить PIN"}</Button></div>
    </form>
  </div>;
}
