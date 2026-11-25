import { useEffect, useState } from "react";
import { ritmChatGPTSignInPath } from "./CloudAuth";
import { Button, Field, Modal, Notice } from "./ui";

type Manager = { id: string; username: string; displayName: string; status: "active" | "disabled"; createdAt: number; lastLoginAt: number | null };
type TemporaryPin = { username: string; value: string; action: "created" | "reset" };
type OwnerPinSettings = { username: string | null; available: boolean; canEdit: boolean };

async function request(path: string, method = "GET", body?: Record<string, unknown>) {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw new Error(value?.message || "Не удалось выполнить запрос.");
  return value;
}

export function ManagerAccessPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [users, setUsers] = useState<Manager[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [temporaryPin, setTemporaryPin] = useState<TemporaryPin | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setBusy(true); setError("");
    try { const result = await request("/api/auth/users"); setUsers(result.users); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось загрузить менеджеров."); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open) void load(); }, [open]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setTemporaryPin(null);
    try {
      const result = await request("/api/auth/users", "POST", { username, displayName });
      setTemporaryPin({ username: result.user.username, value: result.user.temporaryPin, action: "created" });
      setUsername(""); setDisplayName(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать менеджера."); }
    finally { setBusy(false); }
  };

  const resetPin = async (user: Manager) => {
    if (!window.confirm(`Сбросить PIN для ${user.displayName}? Текущие сеансы завершатся.`)) return;
    setBusy(true); setError(""); setTemporaryPin(null);
    try {
      const result = await request(`/api/auth/users/${encodeURIComponent(user.id)}/reset-pin`, "POST", {});
      setTemporaryPin({ username: user.username, value: result.temporaryPin, action: "reset" }); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сбросить PIN."); }
    finally { setBusy(false); }
  };

  const setStatus = async (user: Manager, status: "active" | "disabled") => {
    const action = status === "disabled" ? "Отключить доступ" : "Включить доступ";
    if (!window.confirm(`${action} для ${user.displayName}?${status === "disabled" ? " Все его сеансы завершатся." : ""}`)) return;
    setBusy(true); setError("");
    try { await request(`/api/auth/users/${encodeURIComponent(user.id)}/status`, "POST", { status }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось изменить доступ."); }
    finally { setBusy(false); }
  };

  const copyPin = async () => {
    if (!temporaryPin) return;
    try { await navigator.clipboard.writeText(temporaryPin.value); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setError("Не удалось скопировать PIN. Выделите его и скопируйте вручную."); }
  };

  return <Modal open={open} onClose={onClose} title="Доступы" description="Вход владельца и учётные записи менеджеров">
    <div className="manager-access-panel">
      {open && <OwnerPinAccess />}
      <Notice>Менеджеру доступны все рабочие разделы RITM, кроме AI Center. Управление учётными записями и технические операции остаются владельцу.</Notice>
      {error && <Notice tone="warning">{error}</Notice>}
      {temporaryPin && <div className="manager-temp-pin" role="status">
        <div><strong>{temporaryPin.action === "created" ? "Менеджер создан" : "PIN сброшен"}</strong><span>Логин: <b>{temporaryPin.username}</b> · передайте временный PIN лично. При первом входе его нужно заменить.</span></div>
        <code>{temporaryPin.value}</code>
        <Button type="button" onClick={() => void copyPin()}>{copied ? "Скопировано" : "Скопировать PIN"}</Button>
      </div>}

      <section className="manager-access-section">
        <h3>Добавить менеджера</h3>
        <form className="manager-create-form" onSubmit={create}>
          <Field label="Имя"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} placeholder="Например, Мария" /></Field>
          <Field label="Логин"><input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={40} placeholder="Например, maria" autoComplete="off" /></Field>
          <Button kind="primary" type="submit" disabled={busy || displayName.trim().length === 0 || username.trim().length < 3}>{busy ? "Сохраняю…" : "Создать"}</Button>
        </form>
        <small>Система создаст временный PIN из 8 цифр. После первого входа менеджер задаст свой.</small>
      </section>

      <section className="manager-access-section">
        <div className="manager-access-heading"><h3>Учётные записи</h3><Button type="button" disabled={busy} onClick={() => void load()}>{busy ? "Обновляю…" : "Обновить"}</Button></div>
        {users.length === 0 && !busy ? <p className="manager-empty">Менеджеров пока нет.</p> : <div className="manager-users-list">
          {users.map((user) => <article className="manager-user-row" key={user.id}>
            <div><strong>{user.displayName}</strong><span>{user.username} · {user.status === "active" ? "Доступ включён" : "Доступ отключён"}</span><small>{user.lastLoginAt ? `Последний вход: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(user.lastLoginAt))}` : "Ещё не входил"}</small></div>
            <div className="manager-user-actions">
              {user.status === "active" && <Button type="button" disabled={busy} onClick={() => void resetPin(user)}>Сбросить PIN</Button>}
              <Button type="button" disabled={busy} kind={user.status === "active" ? "danger" : "secondary"} onClick={() => void setStatus(user, user.status === "active" ? "disabled" : "active")}>{user.status === "active" ? "Отключить" : "Включить"}</Button>
            </div>
          </article>)}
        </div>}
      </section>
    </div>
  </Modal>;
}

function OwnerPinAccess() {
  const path = "/api/auth/owner-pin";
  const [settings, setSettings] = useState<OwnerPinSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    let active = true;
    void request(path).then((result: OwnerPinSettings) => {
      if (active) setSettings(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось проверить вход владельца.");
    });
    return () => { active = false; };
  }, []);

  const closeForm = () => {
    setPin("");
    setConfirmPin("");
    setEditing(false);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSaved("");
    if (pin !== confirmPin) {
      setError("PIN-коды не совпадают.");
      return;
    }
    setBusy(true);
    try {
      const result: OwnerPinSettings = await request(path, "POST", { username, pin });
      setSettings(result);
      closeForm();
      setSaved("Вход по PIN настроен.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить вход по PIN.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!window.confirm("Отключить вход владельца по PIN и завершить открытые сеансы по PIN?")) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const result: OwnerPinSettings = await request(path, "DELETE", {});
      setSettings(result);
      closeForm();
      setSaved("Вход по PIN отключён.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отключить вход по PIN.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="owner-pin-access">
    <h3>Вход владельца по PIN</h3>
    {settings && <div className="owner-pin-status">
      <span>{settings.username ? <>Логин <strong>{settings.username}</strong></> : "Вход по PIN ещё не настроен"}</span>
      {settings.canEdit && !editing && <div className="owner-pin-actions">
        {settings.available && <Button type="button" disabled={busy} onClick={() => {
          setUsername(settings.username || "");
          setSaved("");
          setError("");
          setEditing(true);
        }}>{settings.username ? "Изменить" : "Настроить"}</Button>}
        {settings.username && <Button type="button" kind="danger" disabled={busy} onClick={() => void disable()}>Отключить</Button>}
      </div>}
    </div>}
    {!settings && !error && <small role="status">Проверяю вход по PIN…</small>}
    {settings && !settings.available && <Notice tone="warning">Вход по PIN пока недоступен.</Notice>}
    {settings && !settings.canEdit && <small><a href={ritmChatGPTSignInPath} target="_top">Войти через ChatGPT</a> для смены или отключения PIN.</small>}
    {editing && <form className="manager-create-form owner-pin-form" onSubmit={save} autoComplete="off">
      <Field label="Логин"><input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} maxLength={40} required /></Field>
      <Field label="PIN из 4 цифр"><input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))} pattern="[0-9]{4}" maxLength={4} required /></Field>
      <Field label="Повторите PIN"><input type="password" inputMode="numeric" autoComplete="new-password" value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 4))} pattern="[0-9]{4}" maxLength={4} required /></Field>
      <div className="owner-pin-actions">
        <Button type="button" disabled={busy} onClick={() => { closeForm(); setError(""); }}>Отмена</Button>
        <Button type="submit" kind="primary" disabled={busy || username.trim().length < 3 || pin.length !== 4 || confirmPin.length !== 4}>{busy ? "Сохраняю…" : "Сохранить"}</Button>
      </div>
    </form>}
    {error && <Notice tone="warning">{error}</Notice>}
    {saved && <small role="status">{saved}</small>}
  </section>;
}
