import { useEffect, useRef } from "react";
import { Check, ChevronDown, ChevronRight, ClipboardList } from "lucide-react";
import type { Supply } from "../shared/model";

export function ProductionTasks({ supply, selectedId, departments, disabled, onSelect }: {
  supply: Supply;
  selectedId: string | null;
  departments: string[];
  disabled: boolean;
  onSelect(id: string): void;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const sources = supply.sources?.length ? supply.sources : [supply];

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const element = panel.current;
      if (element?.open && event.target instanceof Node && !element.contains(event.target))
        element.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  function close() {
    if (panel.current) panel.current.open = false;
    trigger.current?.focus();
  }

  return (
    <details className="direction-jobs" ref={panel}
      onKeyDown={event => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.preventDefault();
          close();
        }
      }}>
      <summary ref={trigger}>
        <ClipboardList size={17} aria-hidden="true" />
        Задания производства
        <span className="direction-jobs-count">{sources.length}</span>
        <ChevronDown className="direction-jobs-chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="direction-jobs-panel">
        <div className="direction-jobs-heading" aria-hidden="true">
          <span>Задание</span><span>Статус</span>
        </div>
        <ul className="direction-jobs-list" aria-label="Задания производства">
          {sources.map(source => {
            const selected = source.id === selectedId;
            const state = source.sourceLocked ? "locked" : source.sourceActive === false ? "archived" : "active";
            const label = state === "locked" ? "Закрыта в РИТМ" : state === "archived" ? "Архив" : "В работе";
            const canSelect = !selected && source.sourceActive !== false;
            const content = <>
              <span className="direction-jobs-name">{source.title}</span>
              <span className={`direction-jobs-status is-${state}`}>{label}</span>
              {selected ? <Check size={15} aria-hidden="true" /> : canSelect ? <ChevronRight size={15} aria-hidden="true" /> : null}
            </>;
            return (
              <li key={source.id} aria-current={selected || undefined}>
                {canSelect
                  ? <button type="button" className="direction-jobs-row" disabled={disabled}
                      onClick={() => { close(); onSelect(source.id); }}>{content}</button>
                  : <div className="direction-jobs-row">{content}</div>}
              </li>
            );
          })}
        </ul>
        {departments.length > 0 && <div className="direction-jobs-departments">
          <span>Участки</span>
          {departments.map(department => <span key={department}>{department}</span>)}
        </div>}
      </div>
    </details>
  );
}
