import { RefreshCw, ShieldCheck, PackageCheck, ArrowRightLeft } from "lucide-react";
import { useState, type ChangeEvent, type FormEvent } from "react";
import type { SupplyImport } from "../shared/model";
import { dateTime, number } from "../shared/model";
import { unconfirmedStoreArticle } from "../shared/ritm";
import type { Workspace } from "./useWorkspace";
import { Button, Field } from "./ui";
import { WorkplaceLink } from "./Access";
import { ManagerAccessSettings } from "./ManagerAccess";
export function Setup({ workspace: w }: { workspace: Workspace }) {
  const [name, setName] = useState("");
  const [data, setData] = useState<SupplyImport | null>(null);
  const [file, setFile] = useState("");
  const [error, setError] = useState("");
  async function addEmployee(e: FormEvent) {
    e.preventDefault();
    try {
      await w.command(
        "employee.create",
        { name },
        "Сотрудник добавлен в новую версию.",
      );
      setName("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const item = e.target.files?.[0];
    if (!item) return;
    setError("");
    try {
      if (item.size > 2_000_000)
        throw new Error("Размер поставки должен быть не больше 2 МБ.");
      const parsed = JSON.parse(await item.text()) as SupplyImport;
      if (
        !parsed.externalId ||
        !parsed.title ||
        !Array.isArray(parsed.positions)
      )
        throw new Error("Нужен JSON-файл поставки с исходными ID.");
      setData(parsed);
      setFile(item.name);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    }
    e.target.value = "";
  }
  async function apply() {
    if (!data) return;
    try {
      await w.command(
        "supply.import",
        data as unknown as Record<string, unknown>,
        "Поставка загружена в RITM Сборка.",
      );
      setData(null);
      setFile("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function confirmPositionStore(shipmentId: string, sku: string) {
    try {
      await w.command("quality.confirmPositionStore",
        {shipmentId, sku, reason: "Привязка позиции к подтверждённому магазину из справочника"},
        `Магазин для ${sku} подтверждён. Позиция снова доступна для сборки.`);
      setError("");
      void w.syncFromRitm(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="content setup">
      <div className="page-title">
        <div>
          <h1>Подключение</h1>
          <p className="muted">
            Связь с РИТМ, рабочая ссылка и сотрудники.
          </p>
        </div>
      </div>
      <p className="owner-badge"><ShieldCheck size={16}/> Только для владельца</p>
      <div className="setup-grid">
        <ManagerAccessSettings/>
        <WorkplaceLink />
        <section className="panel stack setup-employees">
          <h2>Сотрудники</h2>
          <p className="muted">
            Сборщик выбирает своё имя при записи работы. Это учёт выработки;
            доступ к сайту настраивается отдельно.
          </p>
          <form
            className="stack"
            noValidate
            onSubmit={(e) => void addEmployee(e)}
          >
            <Field
              label="Имя сотрудника"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
            <Button type="submit" primary disabled={w.busy || !name.trim()}>
              Добавить сотрудника
            </Button>
          </form>
          <ul className="employee-list">
            {w.state?.employees
              .filter((e) => e.active)
              .map((e) => (
                <li key={e.id}>
                  <span className="avatar" aria-hidden="true">
                    {e.name[0]}
                  </span>
                  {e.name}
                </li>
              ))}
          </ul>
        </section>
        <section className="panel stack setup-connection">
          <h2>Поставки из РИТМ</h2>
          <div className={`callout ${w.ritm?.configured ? '' : 'connection-unavailable'}`} role="status">
            <strong>
              {w.ritm?.configured
                ? "Связь включена"
                : "Автоматическая передача пока не подключена"}
            </strong>
            <p>
              {w.ritm?.configured
                ? "Подтверждённые поставки поступают из РИТМ. Записанная работа сохраняется в RITM Сборка и передаётся обратно в РИТМ."
                : "Проверьте настройку связи с РИТМ. Сохранённые данные остаются доступны."}
            </p>
          </div>
          {w.ritm?.configured ? (
            <>
              <div className="connection-status-rows"><div><PackageCheck size={20}/><strong>Поставки → RITM Сборка</strong><span>{w.ritm.message}</span></div><div><ArrowRightLeft size={20}/><strong>Работа → РИТМ</strong><span>{w.ritm.workDelivery ? `Передано: ${number(w.ritm.workDelivery.delivered || 0)} · ожидают: ${number(w.ritm.workDelivery.pending || 0)}` : 'Нет подтверждения передачи'}</span></div></div>
              <p>
                {number(w.ritm.supplies)} поставок РИТМ ·{" "}
                {number(w.ritm.groups)} направлений по магазинам ·{" "}
                {number(w.ritm.positions)} позиций
              </p>
              <p className="muted">
                {w.ritm.sourceAt
                  ? `Источник подтверждён ${dateTime(w.ritm.sourceAt)} МСК.`
                  : "Первое подтверждённое чтение ещё не завершено."}{" "}
                История старой версии переносится с исходными ID и отменами.
              </p>
              {w.ritm.workDelivery ? (
                <p role="status">
                  Работа передана в РИТМ:{" "}
                  {number(w.ritm.workDelivery.delivered || 0)} записей · ожидают
                  подтверждения: {number(w.ritm.workDelivery.pending || 0)}.
                </p>
              ) : null}
              <Button
                disabled={w.busy || w.ritm.status === "syncing"}
                onClick={() => void w.syncFromRitm(true)}
              >
                <RefreshCw size={17}/>{w.ritm.status === "syncing"
                  ? "Получаем поставки…"
                  : "Обновить из РИТМ"}
              </Button>
              {w.ritm.issues.length ? (
                <details id="ritm-issues" open={location.hash === "#ritm-issues" || undefined}>
                  <summary>Требуют проверки · {w.ritm.issues.length}</summary>
                  <ul>
                    {w.ritm.issues.slice(0, 100).map((i, n) => {
                      const sku = unconfirmedStoreArticle(i.message);
                      return <li key={n}>
                        <strong>{i.title}</strong>
                        <p>{i.message}</p>
                        {sku && <Button disabled={w.busy} onClick={() => void confirmPositionStore(i.shipmentId, sku)}>
                          Подтвердить магазин для {sku}
                        </Button>}
                      </li>;
                    })}
                  </ul>
                  {w.ritm.issues.length > 100 ? (
                    <p className="muted">Показаны первые 100 замечаний.</p>
                  ) : null}
                </details>
              ) : null}
            </>
          ) : null}
          <details className="setup-advanced"><summary>Дополнительно: загрузить поставку из файла</summary>          <p className="muted">
            Файл сохраняет ID поставки и каждой позиции, участок, маркетплейс,
            магазин, склад назначения, план и норму короба. Повтор той же версии
            не создаёт дубли.
          </p>
          <label className="label upload">
            Загрузить поставку .json
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => void upload(e)}
            />
          </label>
          {data ? (
            <div className="stack">
              <h3>{data.title}</h3>
              <p>
                {data.market} · {data.store} · {data.destination}
              </p>
              <p>
                {data.positions.length} позиций · версия {data.sourceVersion}
              </p>
              <p className="muted">
                {file} · ID {data.externalId}
              </p>
              <Button primary disabled={w.busy} onClick={() => void apply()}>
                Загрузить в новую версию
              </Button>
              <Button onClick={() => setData(null)}>Отменить загрузку</Button>
            </div>
          ) : null}
          <details>
            <summary>Формат файла для подключения</summary>
            <pre>
              {JSON.stringify(
                {
                  externalId: "полный ID поставки из RITM",
                  title: "Название поставки",
                  sourceVersion: 1,
                  market: "OZON",
                  store: "Магазин 1",
                  destination: "Точный склад назначения",
                  positions: [
                    {
                      externalId: "полный ID позиции из RITM",
                      sku: "артикул",
                      name: "Название товара",
                      barcode: "0012345678901",
                      department: "Рулонная печать",
                      plan: 100,
                      unitsPerBox: 100,
                      ready: true,
                      cutOperation: "cut",
                    },
                  ],
                },
                null,
                2,
              )}
            </pre>
          </details>
          </details>
        </section>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

    </main>
  );
}
