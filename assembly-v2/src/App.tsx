import { lazy, Suspense, useEffect, useState } from "react";
import { Collector, CollectorLoading } from "./Collector";
import { Cartons } from "./Cartons";
import { Warehouse } from "./Warehouse";
import { WorkHistory } from "./WorkHistory";
import { Setup } from "./Setup";
import { Button, Status } from "./ui";
import { useWorkspace } from "./useWorkspace";
import { DraftGuard, useDraftNavigation } from "./DraftGuard";
import { Access, useAccess, type AccessRole } from "./Access";
import "./manager.css";
const Catalog = lazy(() =>
  import("./Catalog").then((m) => ({ default: m.Catalog })),
);
const Training = lazy(() => import("./Training"));
const screens = [
  ["assembly", "Сборка"],
  ["cartons", "Короба"],
  ["work", "Выработка"],
  ["warehouse", "Склад и отгрузки"],
  ["catalog", "Справочник"],
  ["setup", "Подключение"],
  ["learning", "Обучение"],
] as const;
function canOpenScreen(view: string, role: AccessRole) {
  if (!screens.some(([id]) => id === view)) return false;
  if (role === "owner") return true;
  return role === "manager"
    ? !["assembly", "setup"].includes(view)
    : ["assembly", "work"].includes(view);
}

export default function App() {
  return (
    <Access><DraftGuard>
      <Application />
    </DraftGuard></Access>
  );
}
function Application() {
  const role = useAccess();
  const home = role === "manager" ? "catalog" : "assembly";
  const [requestedView, setRequestedView] = useState(() => new URLSearchParams(location.search).get("view"));
  const view = requestedView && canOpenScreen(requestedView, role) ? requestedView : home;
  const w = useWorkspace(view);
  const safely = useDraftNavigation();
  useEffect(() => {
    const screen = screens.find(([id]) => id === view)?.[1];
    document.title = screen && view !== "assembly" ? `RITM Сборка — ${screen}` : "RITM Сборка";
  }, [view]);
  function navigate(value: string) {
    if (w.busy || value === view || !canOpenScreen(value, role)) return;
    safely(() => {
      w.clearNotice();
      setRequestedView(value);
      const url = new URL(location.href);
      url.searchParams.set("view", value);
      history.replaceState(null, "", url);
    });
  }
  const onLearning = canOpenScreen("learning", role) ? () => navigate("learning") : undefined;
  if (view === "assembly") {
    return w.state && w.state.cartonScope !== "directory" ? (
      <Collector workspace={w} navigate={navigate} onLearning={onLearning} />
    ) : (
      <CollectorLoading workspace={w} onLearning={onLearning} />
    );
  }
  return (
    <div className={view === "catalog" ? "app manager-app is-catalog" : "app manager-app"}>
      <div className="environment-strip">
        {role==="owner"?"Рабочая версия · управление владельца":role==="manager"?"Рабочая версия · панель менеджера":"Рабочая версия · сборка"}
      </div>
      <header className="header">
        <a
          className="brand"
          href={role==='manager'?'?view=catalog':'?view=assembly'}
          onClick={(e) => {
            e.preventDefault();
            navigate(role==='manager'?'catalog':'assembly');
          }}
        >
          RITM <span>Сборка</span>
        </a>
        <nav className="navigation" aria-label="Разделы RITM Сборка">
          {screens.filter(([id]) => canOpenScreen(id, role)).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="nav-button"
              aria-current={view === id ? "page" : undefined}
              disabled={w.busy}
              onClick={() => navigate(id)}
            >
              {label}
              {id === "cartons" && w.state?.cartons.length
                ? ` · ${w.state.cartons.length}`
                : ""}
            </button>
          ))}
        </nav>
        {role==='manager' && <Button onClick={()=>safely(()=>{void fetch('/api/access/manager/logout',{method:'POST'}).then(response=>{if(response.ok)location.assign('?view=manager-login')})})}>Выйти</Button>}
      </header>
      {view !== "learning" && (
        <Status error={w.error} notice={w.notice} retry={() => void w.refresh()} />
      )}
      {view === "learning" ? (
        <Suspense fallback={<main className="content loading" role="status">Открываем обучение…</main>}>
          <Training
            role={role}
            navigate={navigate}
            canOpen={(screen) => canOpenScreen(screen, role)}
          />
        </Suspense>
      ) : w.loading && (!w.state || (["cartons","warehouse"].includes(view) && w.state.cartonScope !== "all")) ? (
        <main className="content loading" role="status">
          Загружаем поставки…
        </main>
      ) : !w.state ? (
        <main className="content">
          <h1>Не удалось загрузить RITM Сборка</h1>
          <p className="muted">
            Повторите загрузку. Сохранённые записи остаются в базе.
          </p>
          <Button onClick={() => void w.refresh()}>Повторить загрузку</Button>
        </main>
      ) : view === "cartons" ? (
        <Cartons workspace={w} />
      ) : view === "work" ? (
        <WorkHistory workspace={w} />
      ) : view === "warehouse" ? (
        <Warehouse workspace={w} />
      ) : view === "setup" ? (
        <Setup workspace={w} />
      ) : view === "catalog" ? (
        <Suspense
          fallback={
            <main className="content" role="status">
              Загружаем справочник…
            </main>
          }
        >
          <Catalog workspace={w} />
        </Suspense>
      ) : (
        <>
          <Collector workspace={w} navigate={navigate} onLearning={onLearning} />
          {!w.state.supplies.length ? (
            <div className="empty-action">
              <Button primary onClick={() => navigate("setup")}>
                Добавить сотрудников и поставку
              </Button>
            </div>
          ) : null}
        </>
      )}
      <footer>RITM Сборка · управление производством</footer>
    </div>
  );
}
