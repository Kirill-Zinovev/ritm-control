import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  validateDeadlines,
  type Deadlines,
} from "../shared/productionPlanning";
import { requestArkadyPlanning } from "./arkadyPlanningClient";
import { useCloudAuth } from "./CloudAuth";
import { ProductionDeadlineFields } from "./ProductionDeadlineFields";
import { inputInstant, moscowInput } from "./productionForecastModel";
import { Busy, Button, Notice } from "./ui";

type Props = {
  planningKey?: string;
  onSaved?: () => void | Promise<void>;
};
type Snapshot = { revision: number; deadlines: Deadlines };
type Draft = { readyAt: string; packingAt: string; shipAt: string };
const labels = {
  readyAt: "Печать и порезка",
  packingAt: "Упаковка",
  shipAt: "Отгрузка",
};
const fields = ["readyAt", "packingAt", "shipAt"] as const;
const formatter = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  dateStyle: "medium",
  timeStyle: "short",
});

function deadlineDisplay(value: string | null | undefined) {
  return value ? formatter.format(new Date(value)) : "Не задано";
}

function draftFor(deadlines: Deadlines): Draft {
  return {
    readyAt: moscowInput(deadlines.readyAt),
    packingAt: moscowInput(deadlines.packingAt),
    shipAt: moscowInput(deadlines.shipAt),
  };
}

function changedFields(before: Deadlines, after: Deadlines) {
  return fields.filter(
    (field) => (before[field] ?? null) !== (after[field] ?? null),
  );
}

function proposedDeadlines(draft: Draft, saved: Deadlines): Deadlines {
  const instant = (field: keyof Draft) => {
    const value = draft[field];
    if (value === moscowInput(saved[field])) return saved[field] ?? null;
    try {
      const iso = inputInstant(value);
      if (value === moscowInput(iso)) return iso;
    } catch {
      // Show a consistent validation message for invalid input.
    }
    throw new Error(
      "Укажите действительную дату и время в каждом изменённом поле.",
    );
  };
  return validateDeadlines({
    readyAt: instant("readyAt"),
    ...(draft.packingAt || Object.hasOwn(saved, "packingAt")
      ? { packingAt: instant("packingAt") }
      : {}),
    shipAt: instant("shipAt"),
  });
}

async function requestPlanning(
  key: string,
  change?: Snapshot,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const planning = await requestArkadyPlanning(
    signal,
    change ? { action: "deadlines", key, ...change } : undefined,
  );
  return {
    revision: planning.revision,
    deadlines: validateDeadlines(
      Object.hasOwn(planning.deadlines, key) ? planning.deadlines[key] : {},
    ),
  };
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.name === "Error"
    ? error.message
    : fallback;
}

export function ArkadyDeadlines({ planningKey, onSaved }: Props) {
  const { role } = useCloudAuth();
  if (role !== "owner" && role !== "manager")
    return (
      <Notice tone="warning">
        Сроки доступны владельцу и менеджеру РИТМа.
      </Notice>
    );
  if (
    !planningKey ||
    !/^(?:shipment:RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})|sheet:(?:roll|box)-printing:\d+)$/i.test(
      planningKey,
    )
  )
    return (
      <Notice tone="warning">
        Выберите одну поставку с подтверждённым источником.
      </Notice>
    );
  return (
    <DeadlineEditor
      key={planningKey}
      planningKey={planningKey}
      onSaved={onSaved}
    />
  );
}

function DeadlineEditor({
  planningKey,
  onSaved,
}: {
  planningKey: string;
  onSaved?: Props["onSaved"];
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Draft>(() =>
    draftFor({ readyAt: null, shipAt: null }),
  );
  const [proposal, setProposal] = useState<Deadlines | null>(null);
  const [reading, setReading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState<{
    tone: "warning" | "info";
    text: string;
  } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setReading(true);
    setNotice(null);
    void requestPlanning(planningKey, undefined, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setDraft(draftFor(next.deadlines));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSnapshot(null);
        setNotice({
          tone: "warning",
          text: errorText(error, "Не удалось загрузить сроки поставки."),
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [planningKey, retry]);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || reading || inFlight.current) return;
    try {
      const deadlines = proposedDeadlines(draft, snapshot.deadlines);
      if (!changedFields(snapshot.deadlines, deadlines).length) {
        setNotice({ tone: "info", text: "Сроки уже такие." });
        return;
      }
      setProposal(deadlines);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "warning",
        text: errorText(error, "Проверьте сроки поставки."),
      });
    }
  }

  async function confirm() {
    if (!snapshot || !proposal || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setNotice(null);
    let writeError = "";
    try {
      await requestPlanning(planningKey, {
        revision: snapshot.revision,
        deadlines: proposal,
      });
    } catch (error) {
      writeError = errorText(error, "РИТМ не подтвердил запись сроков.");
    }
    let verified = false;
    try {
      const latest = await requestPlanning(planningKey);
      setSnapshot(latest);
      setDraft(draftFor(latest.deadlines));
      verified = changedFields(latest.deadlines, proposal).length === 0;
      setNotice(
        verified
          ? { tone: "info", text: "Проверка подтвердила новые сроки поставки." }
          : {
              tone: "warning",
              text:
                writeError ||
                "После записи сроки отличаются. В форме показаны актуальные значения.",
            },
      );
    } catch {
      setSnapshot(null);
      setNotice({
        tone: "warning",
        text: "Результат записи пока не подтверждён. Обновите сроки для сверки.",
      });
    } finally {
      setProposal(null);
      setSaving(false);
      inFlight.current = false;
    }
    if (verified) {
      try {
        await onSaved?.();
      } catch {
        // The reread already confirmed the saved deadlines.
      }
    }
  }

  return (
    <section className="arkady-assistant__card">
      <h3>Сроки поставки</h3>
      {reading && <Busy label="Читаю сроки поставки…" />}
      {notice && (
        <Notice tone={notice.tone}>
          <span role="status">{notice.text}</span>
        </Notice>
      )}
      {!reading && !snapshot && (
        <Button type="button" onClick={() => setRetry((n) => n + 1)}>
          Обновить сроки
        </Button>
      )}
      {!reading &&
        snapshot &&
        (proposal ? (
          <div className="arkady-assistant__confirm">
            <h4>Подтвердите изменение · МСК</h4>
            {changedFields(snapshot.deadlines, proposal).map((field) => (
              <div
                className="arkady-assistant__comparison"
                key={field}
                aria-label={labels[field]}
              >
                <div>
                  <small>{labels[field]} · было</small>
                  <b>{deadlineDisplay(snapshot.deadlines[field])}</b>
                </div>
                <span aria-hidden="true">→</span>
                <div>
                  <small>Станет</small>
                  <b>{deadlineDisplay(proposal[field])}</b>
                </div>
              </div>
            ))}
            <div className="arkady-assistant__actions">
              <Button
                type="button"
                kind="primary"
                onClick={() => void confirm()}
                disabled={saving}
              >
                {saving ? "Сохраняю и сверяю…" : "Подтвердить сроки"}
              </Button>
              <Button
                type="button"
                onClick={() => setProposal(null)}
                disabled={saving}
              >
                Вернуться к датам
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={prepare}>
            <div className="arkady-assistant__deadline-fields">
              <ProductionDeadlineFields
                ready={draft.readyAt}
                packing={draft.packingAt}
                ship={draft.shipAt}
                onReady={(readyAt) =>
                  setDraft((current) => ({ ...current, readyAt }))
                }
                onPacking={(packingAt) =>
                  setDraft((current) => ({ ...current, packingAt }))
                }
                onShip={(shipAt) =>
                  setDraft((current) => ({ ...current, shipAt }))
                }
              />
            </div>
            <Button type="submit" kind="primary">
              Проверить изменение
            </Button>
          </form>
        ))}
    </section>
  );
}
