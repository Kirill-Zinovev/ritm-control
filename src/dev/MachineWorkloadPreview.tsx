import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MachineWorkload } from "../MachineWorkload";
import { machineWorkloadFixture } from "./machineWorkloadFixture";
import { RitmBackdrop } from "../RitmBackdrop";
import {
  House,
  Users,
  Printer,
  ChartBar,
  Factory,
  Cube,
  Truck,
  Bot,
  Database,
} from "../icons";
import { Button } from "../ui";
import "../styles.css";

function Preview() {
  const [live, setLive] = useState(machineWorkloadFixture),
    [error, setError] = useState("");
  const add = () =>
    setLive((old) => {
      if (old.sheets.some((s) => s.sheetId === 999)) return old;
      const order = {
        ...old.supplies[0],
        uid: "demo-new-position",
        sheetId: 999,
        sheetName: "OZON Новая демо-поставка",
        assemblyShipmentId: "demo-new",
        machine: "УФ бел.",
        quantity: 150,
        printProgress: 0,
        remainingPrint: 150,
        article: "DEMO-NEW",
        productName: "Тестовый товар новой поставки",
      };
      return {
        ...old,
        supplies: [...old.supplies, order],
        sheets: [
          ...old.sheets,
          {
            sheetId: 999,
            sourceId: "roll-printing",
            name: order.sheetName,
            assemblyShipmentId: "demo-new",
          },
        ],
      };
    });
  return (
    <div className="app app--atmosphere">
      <RitmBackdrop />
      <aside className="sidebar">
        <a className="wordmark" href="/?page=overview">
          RITM<span>/</span>
        </a>
        <p className="sidebar-subtitle">
          Управление производством
          <br />
          для WB / Ozon
        </p>
        <nav aria-label="Основное меню">
          {[
            ["overview", "Обзор", House],
            ["assembly", "Сборщики", Users],
            ["printing", "Печать", Printer],
            ["production", "Производство", ChartBar],
            ["machines", "Загрузка станков", Factory],
            ["stock", "Склад", Cube],
            ["supplies", "Поставки", Truck],
            ["intelligence", "AI Center", Bot],
            ["sources", "Источники данных", Database],
          ].map(([id, label, Icon]) => {
            const Glyph = Icon as typeof House;
            return (
              <a
                key={String(id)}
                href={`/?page=${id}`}
                className={id === "machines" ? "nav-link active" : "nav-link"}
              >
                <Glyph size={22} />
                <span>{String(label)}</span>
              </a>
            );
          })}
        </nav>
      </aside>
      <main className="machine-workload-page">
        <header className="page-header">
          <div>
            <h1>Загруженность станков</h1>
            <p>Поставки, участки и прогресс по станкам</p>
          </div>
        </header>
        {new URLSearchParams(location.search).get("scenarios") === "1" && (
          <div
            className="mw-preview-tools"
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 16,
            }}
          >
            <Button onClick={add}>Пример: новая поставка</Button>
            <Button
              onClick={() =>
                setLive((old) => ({
                  ...old,
                  supplies: old.supplies.filter((o) => o.sheetId !== 999),
                  sheets: old.sheets.filter((s) => s.sheetId !== 999),
                }))
              }
            >
              Убрать новую поставку
            </Button>
            <Button
              onClick={() =>
                setError(
                  error
                    ? ""
                    : "Пример ошибки чтения. Сохранён последний успешный снимок.",
                )
              }
            >
              Ошибка источника
            </Button>
            <Button
              onClick={() => {
                setLive((old) => ({
                  ...old,
                  supplies: old.supplies.map((o, i) =>
                    i === 0 ? { ...o, machine: "Неизвестный станок" } : o,
                  ),
                }));
              }}
            >
              Станок не определён
            </Button>
            <Button
              onClick={() => {
                setLive(machineWorkloadFixture());
                setError("");
              }}
            >
              Сбросить пример
            </Button>
          </div>
        )}
        <MachineWorkload
          live={live}
          error={error}
          loading={false}
          demo
          onRefresh={() => {
            setLive((old) => ({ ...old, updatedAt: new Date().toISOString() }));
            setError("");
          }}
        />
      </main>
    </div>
  );
}
const previewRoot = createRoot(document.getElementById("root")!);
previewRoot.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount());
