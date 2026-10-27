import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OverviewDashboard } from "../OverviewDashboard";
import { ProductionDashboard } from "../ProductionDashboard";
import { machineWorkloadFixture } from "./machineWorkloadFixture";
import { RitmBackdrop } from "../RitmBackdrop";
import { House, Users, Printer, ChartBar, Factory, Cube, Truck, Bot, Database } from "../icons";
import type { LiveAssembly, AssemblyDaily } from "../liveAssembly";
import "../styles.css";

const date = "2026-10-27";
const live = machineWorkloadFixture();
const scenario = new URLSearchParams(location.search).get("scenario");
live.supplies = live.supplies.map((order, index) => ({ ...order,
  packed: scenario === "partial" && index === 0 ? null : scenario === "over" && order.assemblyShipmentId === "demo-moscow" ? order.quantity + 10 : Math.max(0, (order.printProgress || 0) - (index % 2 ? 300 : 100)),
  ...(scenario === "partial" && index === 0 ? { machine: "", machineSource: null } : {}),
}));
if (scenario === "partial") live.stale = true;
live.events = [{ id: "demo-print", uid: "demo", roll: "demo", employee: "Дмитрий", date, article: "DEMO-1001", quantity: 100, area: 318.8, sheetName: "OZON МОСКВА 10_10", sheetId: 101, source: "demo" }];
live.sheets.push({ sheetId: 303, sourceId: "seasonal-printing", name: "OZON НОВЫЙ ГОД" });
live.supplies.push({ ...live.supplies[0], uid: "demo-seasonal", assemblyShipmentId: null, sourceId: "seasonal-printing", sheetId: 303, sheetName: "OZON НОВЫЙ ГОД", quantity: 1941 });
live.events.push({ ...live.events[0], id: "demo-seasonal-print", sourceId: "seasonal-printing", sheetId: 303, sheetName: "OZON НОВЫЙ ГОД", area: 120 });
const rows: AssemblyDaily[] = ["Анна", "Мария", "Елена"].map((name, i) => ({
  employee: name, employeeId: `demo-${i}`, identityKey: `demo-${i}`, date,
  coefficient: 0.8 + i * 0.2, machineCut: 0, manualCut: 0, cut: 0, packed: 600 + i * 100, total: 600 + i * 100, days: 1, cutTypes: [], packTypes: [], reconciliationStatus: "clear",
  sourceContributions: [{ sourceKind: "assembly", employeeLabel: name, employeeId: `demo-${i}`, coefficient: 0.8 + i * 0.2, machineCut: 0, manualCut: 0, cut: 0, packed: 600 + i * 100, total: 600 + i * 100, recordCount: 1, cutTypes: [], packTypes: [], reconciliationStatus: "clear" }],
}));
const checkedAt = "2026-10-27T09:00:00Z";
const assembly: LiveAssembly = { ok: true, schemaVersion: 2, source: "demo", date, period: "day", updatedAt: checkedAt, rows, history: rows, sources: {
  fbo: { status: "available", checkedAt, recordCount: 0, source: "demo", sheet: "demo" },
  assembly: { status: "available", checkedAt, eventCount: 3, invalidRecords: 0, message: "", source: "demo", supportsCorrections: true, correctionsApplied: 0, cancellationsApplied: 0 },
  catalog: { status: "available", missingRecords: 0, message: "" },
} };
function Preview() {
  const [selectedSupply, setSelectedSupply] = useState<string | null>(null);
  return <div className="app app--atmosphere"><RitmBackdrop /><aside className="sidebar"><a className="wordmark" href="/overview-preview.html">RITM<span>/</span></a><p className="sidebar-subtitle">Управление производством<br />для WB / Ozon</p><nav aria-label="Основное меню">{[["Обзор", House], ["Сборщики", Users], ["Печать", Printer], ["Производство", ChartBar], ["Загрузка станков", Factory], ["Склад", Cube], ["Поставки", Truck], ["AI Center", Bot], ["Источники данных", Database]].map(([label, Icon], index) => { const Glyph = Icon as typeof House; return <span key={String(label)} className={`nav-link${index === 0 ? " active" : ""}`}><Glyph size={22} /><span>{String(label)}</span></span>; })}</nav></aside><main><header className="page-header"><div><h1>{selectedSupply === null ? "Обзор производства" : "Производство"}</h1><p>Вся смена на одном экране · пример данных</p></div>{selectedSupply !== null && <button type="button" className="button secondary" onClick={() => setSelectedSupply(null)}>Назад к обзору</button>}</header>{selectedSupply === null ? <OverviewDashboard live={live} liveError="" assembly={assembly} assemblyError="" date={date} period="day" go={(page, supply) => { if (page === "production") setSelectedSupply(supply || "all"); }} /> : <ProductionDashboard live={live} loading={false} error="" initialSupply={selectedSupply} />}</main></div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
