import { useMemo, type ReactNode } from "react";
import { ArrowRight, ChartBar, Factory, Package, Printer, Truck, Users, Warning } from "./icons";
import type { LivePrinting } from "./livePrinting";
import type { LiveAssembly } from "./liveAssembly";
import { inPeriod, num, type Page, type Period } from "./model";
import { buildProductionGroups, productionFact, type Fact } from "./productionData";
import { buildMachineWorkload, countWord, summarizeMachines, workloadState, type WorkloadMachine } from "./machineWorkloadData";
import "./overviewDashboard.css";

type Props = {
  live: LivePrinting | null;
  liveError: string;
  assembly: LiveAssembly | null;
  assemblyError: string;
  date: string;
  period: Period;
  go: (page: Page, supply?: string) => void;
};
const positions = (count: number) => `${num(count)} ${countWord(count, "позиция", "позиции", "позиций")}`;
const percentText = (value: number) => value > 100 && Math.round(value * 10) === 1000 ? ">100%" : value < 100 && Math.round(value * 10) === 1000 ? "<100%" : `${num(value, 1)}%`;

function Metric({ label, value, note, icon, tone = "blue" }: { label: string; value: string; note: string; icon: ReactNode; tone?: string }) {
  return <div className="ov-metric"><span className={`ov-icon is-${tone}`}>{icon}</span><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></div>;
}

function Progress({ fact, plan, label }: { fact: Fact; plan: number; label: string }) {
  if (fact.value === null) return <div className="ov-progress"><span className="ov-progress-name">{label}</span><strong>—</strong><small>Нет подтверждённых данных</small></div>;
  const percentage = plan > 0 ? fact.value / plan * 100 : null;
  return <div className="ov-progress">
    <span className="ov-progress-name">{label}</span>
    <div className="ov-progress-values"><strong>{num(fact.value)} / {num(plan)}</strong><b>{fact.complete && percentage !== null ? percentText(percentage) : "Частично"}</b></div>
    <div className="ov-track" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, percentage ?? 0))}%` }} /></div>
    {!fact.complete && <small>Подтверждено {fact.known} из {fact.expected}</small>}
    {fact.complete && fact.value > plan && <small className="ov-over">+{num(fact.value - plan)} сверх плана</small>}
  </div>;
}

export function OverviewDashboard({ live, liveError, assembly, assemblyError, date, period, go }: Props) {
  const groups = useMemo(() => buildProductionGroups(live), [live]);
  const machines = useMemo(() => {
    const keyed = new Map<string, WorkloadMachine[]>();
    for (const item of buildMachineWorkload(live).flatMap((supply) => supply.machines)) {
      const key = `${item.department}:${item.id}`;
      keyed.set(key, [...(keyed.get(key) || []), item]);
    }
    return [...keyed.values()].map((items) => summarizeMachines(items.flatMap((item) => item.rows), items[0].id, items[0].label, items[0].department));
  }, [live]);
  const orders = groups.flatMap((group) => group.orders);
  const printingPartial = live?.quality?.status === "partial";
  const seasonal = (live?.sheets || []).filter((sheet) => sheet.sourceId === "seasonal-printing").map((sheet) => {
    const sheetOrders = (live?.supplies || []).filter((order) => order.sheetId === sheet.sheetId);
    const sheetEvents = (live?.events || []).filter((event) => event.sheetId === sheet.sheetId && inPeriod(event.date, date, period));
    const confirmedOrders = sheetOrders.filter((order) => order.sourceId === sheet.sourceId);
    const confirmedEvents = sheetEvents.filter((event) => event.sourceId === sheet.sourceId);
    return {
      ...sheet,
      plan: sheetOrders.some((order) => !order.sourceId) ? null : confirmedOrders.reduce((sum, order) => sum + order.quantity, 0),
      area: sheetEvents.some((event) => !event.sourceId) || (printingPartial && !confirmedEvents.length) ? null : confirmedEvents.reduce((sum, event) => sum + event.area, 0),
    };
  });
  const plan = orders.reduce((sum, order) => sum + order.quantity, 0);
  const packed = productionFact(orders.map((order) => order.packed));
  const periodEvents = live?.events.filter((event) => inPeriod(event.date, date, period)) || [];
  const printedArea = live && (!printingPartial || periodEvents.length) ? periodEvents.reduce((sum, event) => sum + event.area, 0) : null;
  const machineWithRemaining = machines.filter((machine) => machine.id !== "unknown" && ["pending", "remaining"].includes(workloadState(machine)));
  const uncertainMachines = machines.filter((machine) => machine.id !== "unknown" && workloadState(machine) === "unknown").length;
  const missingMachine = machines.filter((machine) => machine.id === "unknown").reduce((sum, machine) => sum + machine.rows.length, 0);
  const work = (assembly?.history || []).filter((row) => inPeriod(row.date, date, period) && (row.machineCut > 0 || row.manualCut > 0 || row.packed > 0 || (row.coefficient ?? 0) > 0));
  const people = new Set(work.map((row) => row.identityKey || (row.employeeId ? `assembly:${row.employeeId}` : `fbo:${row.employee}`))).size;
  const contributions = work.flatMap((row) => row.sourceContributions || []);
  const assemblyComplete = !!assembly && !assemblyError && !assembly.stale && !assembly.staleSnapshot && assembly.sources?.fbo.status === "available" && assembly.sources?.assembly.status === "available" && assembly.quality?.status !== "partial" && work.every((row) => !!row.sourceContributions?.length);
  const employeePacked = contributions.length || (assemblyComplete && !work.length) ? contributions.reduce((sum, source) => sum + source.packed, 0) : null;
  const employeeCoefficient = contributions.every((source) => source.coefficient !== null) && (contributions.length || (assemblyComplete && !work.length)) ? contributions.reduce((sum, source) => sum + (source.coefficient || 0), 0) : null;
  const overlap = work.some((row) => row.reconciliationStatus !== "clear");
  const bothSources = contributions.some((source) => source.sourceKind === "fbo") && contributions.some((source) => source.sourceKind === "assembly");
  const periodName = period === "day" ? "за день" : period === "week" ? "за неделю" : "за месяц";
  const stale = !!live && (live.stale || live.refreshFailed || !!liveError);
  const assemblyStale = !!assembly && (assembly.stale || assembly.staleSnapshot || !!assemblyError);
  const issues = [
    ...(missingMachine ? [{ key: "machine", text: `Станок не определён: ${positions(missingMachine)}`, page: "machines" as Page }] : []),
    ...(orders.length && !packed.complete ? [{ key: "packing", text: `Упаковка подтверждена не по всем позициям: ${num(packed.known)} из ${num(packed.expected)}`, page: "production" as Page }] : []),
    ...(printingPartial ? [{ key: "printing-quality", text: live?.quality?.invalidRecords ? `Часть записей печати не проверена: ${num(live.quality.invalidRecords)}` : "Источник печати сообщает о неполных данных", page: "printing" as Page }] : []),
    ...(liveError || stale ? [{ key: "printing", text: "Данные печати требуют обновления", page: "printing" as Page }] : []),
    ...(assemblyError || assemblyStale || (assembly && !assemblyComplete) ? [{ key: "assembly", text: "Данные сборщиков неполные или устарели", page: "assembly" as Page }] : []),
  ];
  return <div className="ov-dashboard">
    {(stale || assemblyStale) && <div className="ov-warning"><Warning size={19} /><span>Показаны последние доступные данные. {stale ? "Источник печати не подтвердил обновление. " : ""}{assemblyStale ? "Источник сборщиков не подтвердил обновление." : ""}</span></div>}
    <section className="ov-metrics" aria-label="Общие показатели">
      <Metric label="Поставки рулона и бокса" value={live ? num(groups.length) : "—"} note="Объединены по общему ID" icon={<Truck size={24} />} />
      <Metric label="Упаковано по поставкам" value={packed.value === null ? "—" : `${num(packed.value)} шт.`} note={packed.value === null ? "Нет подтверждённых данных" : packed.complete ? `${num(plan)} шт. по плану · ${plan ? percentText(packed.value / plan * 100) : "план не указан"}` : `Частично: ${num(packed.known)} из ${num(packed.expected)} позиций`} icon={<Package size={24} />} tone="teal" />
      <Metric label={`Напечатано ${periodName}`} value={printedArea === null ? "—" : `${num(printedArea, 1)} м²`} note={printingPartial ? "По доступным записям журнала" : "По журналу печати"} icon={<Printer size={24} />} />
      <Metric label="Станки с остатком" value={live ? num(machineWithRemaining.length) : "—"} note={uncertainMachines ? `Ещё ${num(uncertainMachines)} без полного факта` : "По подтверждённым данным"} icon={<Factory size={24} />} tone="teal" />
    </section>
    <section className="ov-panel ov-supplies">
      <div className="ov-heading"><div><h2>Поставки</h2><p>Текущее состояние по подтверждённым данным</p></div><button type="button" className="ov-link" onClick={() => go("production")}>Все поставки <ArrowRight size={17} /></button></div>
      {!live ? <p className="ov-empty">Данные поставок пока недоступны.</p> : !groups.length ? <p className="ov-empty">Поставки рулонной печати и бокса не найдены. Остальные листы доступны в разделе «Печать».</p> : <div className="ov-table-wrap"><table className="ov-table"><thead><tr><th>Поставка</th><th>План, шт.</th><th>Печать</th><th>Резка</th><th>Упаковка</th></tr></thead><tbody>{groups.slice(0, 5).map((group) => <tr key={group.key}>
        <td><button className="ov-supply-link" type="button" onClick={() => go("production", group.key)}><span className={`ov-market ${group.market === "Ozon" ? "is-ozon" : group.market === "WB" ? "is-wb" : "is-unknown"}`}>{group.market === "Ozon" ? "OZON" : group.market === "WB" ? "WB" : "?"}</span><span><strong>{group.name}</strong><small>{positions(group.rows.length)}</small></span></button></td>
        <td><strong>{num(group.plan)}</strong></td><td><Progress label="Печать" fact={group.printed} plan={group.plan} /></td><td><Progress label="Резка" fact={group.cut} plan={group.plan} /></td><td className="ov-packed"><Progress label="Упаковка" fact={group.packed} plan={group.plan} /></td>
      </tr>)}</tbody></table></div>}
      {groups.length > 5 && <div className="ov-footer">Показано 5 из {num(groups.length)} поставок <button type="button" className="ov-link" onClick={() => go("production")}>Показать все <ArrowRight size={15} /></button></div>}
      <p className="ov-panel-note">План и готовность — на момент обновления. Листы сезонной печати доступны в разделе «Печать».</p>
    </section>
    {!!seasonal.length && <section className="ov-panel ov-seasonal"><div className="ov-heading"><div><h2>Сезонная печать</h2><p>Листы печати · отдельно от объединённых поставок</p></div><button type="button" className="ov-link" onClick={() => go("printing")}>Все листы <ArrowRight size={17} /></button></div><div className="ov-seasonal-list">{seasonal.slice(0, 3).map((sheet) => <button type="button" className="ov-seasonal-item" key={`${sheet.sourceId}:${sheet.sheetId}`} onClick={() => go("printing")}><strong>{sheet.name}</strong><span>{sheet.plan === null ? "План не подтверждён" : `${num(sheet.plan)} шт. по плану`}</span><small>{sheet.area === null ? "Печать не подтверждена" : `${num(sheet.area, 1)} м² ${periodName}${printingPartial ? " · частично" : ""}`}</small></button>)}</div>{seasonal.length > 3 && <p className="ov-panel-note">Показано 3 из {num(seasonal.length)} листов.</p>}</section>}
    <div className="ov-bottom">
      <section className="ov-panel"><div className="ov-heading"><div><h2>Загрузка станков</h2><p>Остаток печати по заданиям</p></div><button type="button" className="ov-link" onClick={() => go("machines")}>Все станки <ArrowRight size={17} /></button></div>
        {!live ? <p className="ov-empty">Данные станков пока недоступны.</p> : !machines.filter((m) => m.id !== "unknown").length ? <p className="ov-empty">Подтверждённых назначений станков пока нет.</p> : <div className="ov-machines">{machines.filter((m) => m.id !== "unknown").slice(0, 4).map((machine) => <button type="button" className="ov-machine" key={machine.key} onClick={() => go("machines")}><span className="ov-machine-icon"><Printer size={21} /></span><span><strong>{machine.label}</strong><small>{machine.department === "box" ? "Бокс" : "Рулонная печать"} · {positions(machine.rows.length)}</small></span><span className="ov-machine-progress"><Progress label="Напечатано" fact={machine.printed} plan={machine.plan} /></span></button>)}</div>}
        <p className="ov-panel-note">Задания не означают, что станок сейчас работает.</p>
      </section>
      <section className="ov-panel"><div className="ov-heading"><div><h2>Сборщики</h2><p>Результаты {periodName}</p></div><button type="button" className="ov-link" onClick={() => go("assembly")}>Все сборщики <ArrowRight size={17} /></button></div>
        <div className="ov-team-stats"><Metric label="Сотрудники с записями" value={assembly && (work.length > 0 || assemblyComplete) ? num(people) : "—"} note={assemblyComplete ? "За выбранный период" : "По доступным данным"} icon={<Users size={22} />} /><Metric label="Упаковано" value={employeePacked === null ? "—" : `${num(employeePacked)} шт.`} note="FBO + Assembly" icon={<Package size={22} />} tone="teal" /><Metric label="Сумма коэффициентов" value={employeeCoefficient === null ? "—" : num(employeeCoefficient, 3)} note="FBO + Assembly" icon={<ChartBar size={22} />} /></div>
        {assembly && (!assemblyComplete || overlap || bothSources) && <p className="ov-panel-note">{!assemblyComplete ? "Источники доступны частично. " : ""}{overlap || bothSources ? "Возможные повторы между источниками не вычитались." : ""}</p>}
        {!assembly && <p className="ov-panel-note">{assemblyError || "Данные сборщиков пока недоступны."}</p>}
      </section>
    </div>
    {!!issues.length && <section className="ov-attention"><Warning size={22} /><div><strong>Требует внимания</strong>{issues.map((issue) => <button type="button" key={issue.key} onClick={() => go(issue.page)}>{issue.text} <ArrowRight size={15} /></button>)}</div></section>}
  </div>;
}
