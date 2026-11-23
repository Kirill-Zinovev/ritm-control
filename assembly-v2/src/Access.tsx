import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Button, Status } from "./ui";
import { ManagerLogin } from "./ManagerAccess";
export type AccessRole = "owner" | "manager" | "collector";
const RoleContext = createContext<AccessRole>("owner");
export const useAccess = () => useContext(RoleContext);
let initialAccess: Promise<AccessRole | null> | undefined;
async function currentRole(): Promise<AccessRole | null> {
  const response = await fetch("/api/access", { cache: "no-store" });
  if (!response.ok)
    throw new Error("Не удалось проверить рабочую ссылку. Повторите загрузку.");
  const data = await response.json();
  return ['owner','manager','collector'].includes(data.role) ? data.role : null;
}

export async function openWorkplace(): Promise<AccessRole | null> {
  const fragment = new URLSearchParams(location.hash.slice(1)),
    token = fragment.get("access");
  // Keep an existing workplace session and its device identity when reopening
  // or sharing the link. The fragment remains local to the browser.
  const existing = await currentRole();
  if (existing || !token) return existing;

  const response = await fetch("/api/access/collector", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error || "Не удалось открыть рабочую ссылку.");
  }

  const role = await currentRole();
  if (!role)
    throw new Error(
      "Браузер не сохранил рабочий доступ. Разрешите файлы cookie для этого сайта и повторите попытку.",
    );
  return role;
}
export function Access({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<AccessRole | null | undefined>(),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let generation = 0;
    function checkAccess(refresh = false) {
      const current = ++generation;
      if (refresh) initialAccess = undefined;
      initialAccess ??= openWorkplace();
      void initialAccess
        .then((value) => {
          if (alive && current === generation) {
            setError("");
            setRole(value);
          }
        })
        .catch((reason) => {
          if (alive && current === generation) {
            setRole(null);
            setError(
              reason instanceof Error
                ? reason.message
                : "Не удалось открыть RITM Сборка.",
            );
            initialAccess = undefined;
          }
        });
    }
    // Opening a bookmark on an already open Assembly changes only the fragment.
    function openLink() {
      if (new URLSearchParams(location.hash.slice(1)).has("access")) {
        setRole(undefined);
        checkAccess(true);
      }
    }
    window.addEventListener("hashchange", openLink);
    checkAccess();
    return () => {
      alive = false;
      window.removeEventListener("hashchange", openLink);
    };
  }, []);
  if(role!==undefined && role!=='owner' && role!=='manager' && new URLSearchParams(location.search).get('view')==='manager-login')return <ManagerLogin/>;
  if (role) return <RoleContext value={role}>{children}</RoleContext>;
  return (
    <main className="content">
      <div className="page-title">
        <div>
          <p className="muted">RITM Сборка</p>
          <h1>
            {role === undefined
              ? "Загружаем рабочее место…"
              : "Откройте рабочую ссылку"}
          </h1>
        </div>
      </div>
      {role !== undefined && (
        <>
          <p>
            Используйте ссылку, полученную от руководителя. Регистрация и PIN не
            нужны. Своё имя вы выбираете при записи работы.
          </p>
          <Status error={error} notice="" retry={() => location.reload()} />
          <a
            className="button"
            href="/signin-with-chatgpt?return_to=%2F%3Fview%3Dsetup"
            target="_top"
          >
            Вход владельца
          </a>
          <a className="button" href="?view=manager-login">Вход менеджера</a>
        </>
      )}
    </main>
  );
}
export function WorkplaceLink() {
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function show() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access/link", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setUrl(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось получить ссылку.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Ссылка для сборщиков</h2>
      <p className="muted">
        Одна рабочая ссылка: открыть, выбрать своё имя и записать работу.
        Управление справочником и отгрузками остаётся у владельца. Передавайте
        ссылку только сотрудникам.
      </p>
      <Status error={error} notice={notice} retry={() => void show()} />
      {!url ? (
        <Button disabled={busy} onClick={() => void show()}>
          Показать рабочую ссылку
        </Button>
      ) : (
        <>
          <label className="field">
            <span>Рабочая ссылка</span>
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <Button
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => setNotice("Ссылка скопирована."))
                .catch(() => setError("Выделите и скопируйте ссылку из поля."))
            }
          >
            Скопировать ссылку
          </Button>
        </>
      )}
    </section>
  );
}
