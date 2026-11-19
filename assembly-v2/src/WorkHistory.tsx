import { Fragment, useEffect, useState } from "react";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import type { Work } from "../shared/model";
import { dateTime, number, operationLabels } from "../shared/model";
import type { Workspace } from "./useWorkspace";
import { request } from "./useWorkspace";
import { ProductPhoto } from "./ProductPhoto";
import {
  Button,
  Dialog,
  Empty,
  Field,
  NativeSelect,
  Pagination,
  Search,
} from "./ui";
export function WorkHistory({ workspace: w }: { workspace: Workspace }) {
  const params = new URLSearchParams(location.search);
  const [employee, setEmployee] = useState(params.get("historyEmployee") || ""),
    [supply, setSupply] = useState(params.get("historySupply") || ""),
    [query, setQuery] = useState(params.get("historyQ") || ""),
    [page, setPage] = useState(Number(params.get("historyPage")) || 0);
  const [data, setData] = useState<{
      total: number;
      totals?: { qty: number; coefficient: number; missingCoefficient: number };
      items: (Work & { supply: string; supplyId: string })[];
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const [cancel, setCancel] = useState<Work | null>(null);
  const [expanded,setExpanded]=useState<string|null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const url = new URL(location.href);
    for (const [k, v] of Object.entries({
      historyEmployee: employee,
      historySupply: supply,
      historyQ: query,
      historyPage: String(page),
    })) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    history.replaceState(null, "", url);
    const timer = setTimeout(() => {
      void request<{
        total: number;
        items: (Work & { supply: string; supplyId: string })[];
      }>(
        `/api/work-history?employee=${encodeURIComponent(employee)}&supply=${encodeURIComponent(supply)}&q=${encodeURIComponent(query)}&page=${page}`,
        { signal: abort.signal },
      )
        .then(setData)
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [employee, supply, query, page, retry, w.state?.revision]);
  const state = w.state;
  if (!state) return null;
  return (
    <main className="content manager-history">
      <div className="page-title">
        <div>
          <h1>Выработка</h1>
          <p className="muted">
            Кто выполнил работу и как рассчитан коэффициент. Время — московское.
          </p>
        </div>
        <Button disabled={loading} onClick={() => setRetry((n) => n + 1)}>
          <RefreshCw size={17}/> Обновить журнал
        </Button>
      </div>
      <div className="toolbar">
        <NativeSelect
          label="Поставка"
          value={supply}
          onChange={(e) => {
            setSupply(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Все поставки</option>
          <option value="warehouse">На склад / Запас</option>
          {state.supplies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} · {s.store}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          label="Сборщик"
          value={employee}
          onChange={(e) => {
            setEmployee(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Все сотрудники</option>
          {state.employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </NativeSelect>
        <Search
          value={query}
          onChange={(q) => {
            setQuery(q);
            setPage(0);
          }}
        />
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {data?.totals && !loading && (
        <p className="muted">
          По фильтрам без отмен: {number(data.totals.qty)} шт. ·{" "}
          {data.totals.missingCoefficient
            ? "Известный коэффициент"
            : "Коэффициент"}
          :{" "}
          {data.totals.coefficient.toLocaleString("ru-RU", {
            maximumFractionDigits: 4,
          })}
          {data.totals.missingCoefficient
            ? ` · без подтверждённой нормы: ${data.totals.missingCoefficient} записей`
            : ""}
        </p>
      )}
      {loading ? (
        <p role="status">Загружаем журнал…</p>
      ) : data?.items.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Время, МСК</th>
                <th>Сборщик</th>
                <th>Товар и поставка</th>
                <th>Операция</th>
                <th>Количество</th>
                <th>Норма</th>
                <th>Коэффициент</th>
                <th><span className="sr-only">Подробности записи</span></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((x) => (
                <Fragment key={x.id}><tr className={expanded===x.id?'is-selected':x.canceled?'work-canceled':''}>
                  <td>{dateTime(x.createdAt)}</td>
                  <td><div className="employee-cell"><span className="avatar">{x.employee.slice(0,1)}</span>{x.employee}</div></td>
                  <td>
                    <div className="work-product"><ProductPhoto importId={x.catalogImportId || ''} id={x.photoId || null} sourceUrl={x.photoUrl} sku={x.sku}/><div><strong>{x.sku}</strong><p className="work-product-name">{x.name}</p>
                    {x.scope === "warehouse" ? x.supply : <a
                      href={`?view=assembly&supply=${encodeURIComponent(x.supplyId)}&filter=all&q=${encodeURIComponent(x.sku)}`}
                    >
                      {x.supply}
                    </a>}</div></div>
                  </td>
                  <td><span className={`operation-pill ${x.operation}`}>{operationLabels[x.operation]}</span></td>
                  <td className="numeric">{number(x.qty)} шт.</td>
                  <td className="numeric">
                    {x.norm
                      ? Number(x.norm).toLocaleString("ru-RU", {
                          maximumFractionDigits: 2,
                        })
                      : "Не задана"}
                  </td>
                  <td className="coefficient numeric">
                    {x.canceled
                      ? "Отменена"
                      : x.coefficient !== null && x.coefficient !== undefined
                        ? Number(x.coefficient).toLocaleString("ru-RU", {
                            maximumFractionDigits: 4,
                          })
                        : "Нет нормы"}
                  </td>
                  <td>
                    <button type="button" className="icon-button" aria-label={`Подробности ${x.sku} · ${x.employee}`} aria-expanded={expanded===x.id} onClick={()=>setExpanded(expanded===x.id?null:x.id)}><MoreHorizontal size={20}/></button>
                  </td>
                </tr>
                {expanded===x.id && <tr className="work-detail-row"><td colSpan={8}><div className="work-detail-actions"><span>{x.canceled ? `Отменена: ${x.cancelReason}` : x.norm && x.coefficient!=null ? `Расчёт: ${number(x.qty)} ÷ ${Number(x.norm).toLocaleString('ru-RU')} = ${Number(x.coefficient).toLocaleString('ru-RU',{maximumFractionDigits:4})}` : 'Норма не подтверждена'}{x.scope==='warehouse'?' · Работа в запас':''}</span>{!x.canceled && <Button danger onClick={()=>setCancel(x)}>Отменить запись</Button>}</div></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="По выбранным фильтрам записей нет">
          Выберите все поставки или измените поиск.
        </Empty>
      )}
      {data ? (
        <Pagination
          page={page}
          size={20}
          total={data.total}
          onChange={setPage}
        />
      ) : null}
      <p className="muted help">Коэффициент сохранён на момент записи. Резка и упаковка учитываются отдельно для каждого сотрудника.</p>
      {cancel ? (
        <CancelWorkDialog
          work={cancel}
          workspace={w}
          onClose={() => setCancel(null)}
        />
      ) : null}
    </main>
  );
}

export function CancelWorkDialog({
  work,
  workspace: w,
  onClose,
}: {
  work: Work;
  workspace: Workspace;
  onClose(): void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function save() {
    try {
      await w.command(
        "work.cancel",
        { workId: work.id, reason },
        "Запись работы отменена. История сохранена.",
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog title="Отменить запись работы" busy={w.busy} onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p>
          {work.employee} · {work.sku} · {operationLabels[work.operation]} ·{" "}
          {number(work.qty)} шт.
        </p>
        <p className="muted">
          {work.scope === "warehouse" && work.operation !== "packing"
            ? "Запись резки останется в истории, её кэф уберётся из выработки. Упаковка и готовые остатки других сотрудников не изменятся."
            : work.scope === "warehouse"
            ? "Исходная запись останется в истории. Количество новой упаковки уберётся из складского короба, кэф — из выработки. Для отмены складской короб должен быть открыт."
            : "Исходная запись останется в истории. При отмене упаковки её количество автоматически уберётся из коробов поставки. Закрытые короба откроются для повторной проверки. Короба в отгрузке защищены от изменения."}
        </p>
        <Field
          label="Причина отмены"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={error || undefined}
        />
        <div className="actions">
          <Button disabled={w.busy} onClick={onClose}>
            Вернуться
          </Button>
          <Button
            danger
            type="submit"
            disabled={w.busy || reason.trim().length < 3}
          >
            Отменить запись
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
