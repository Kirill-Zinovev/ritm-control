import type { ReactNode } from "react";
import { ArrowSquareOut } from "./icons";
import "./shipmentHero.css";

type ShipmentHeroProps = {
  marketplace: "Ozon" | "WB" | null;
  title: string;
  department: string;
  sourceHref?: string;
  actions?: ReactNode;
  children?: ReactNode;
};

/** Shared by the supply workbench and its local design preview. */
export function ShipmentHero({
  marketplace,
  title,
  department,
  sourceHref,
  actions,
  children,
}: ShipmentHeroProps) {
  const theme =
    marketplace === "WB" ? "wb" : marketplace === "Ozon" ? "ozon" : "neutral";
  const brand =
    marketplace === "WB"
      ? "Wildberries"
      : marketplace === "Ozon"
        ? "Ozon"
        : "RITM";

  return (
    <section className="panel shipment-hero" data-marketplace={theme}>
      <div className="shipment-hero-banner">
        {marketplace && (
          <div className="shipment-hero-art" aria-hidden="true" />
        )}
        <div className="shipment-hero-heading">
          <span className="shipment-hero-brand" aria-hidden="true">
            {marketplace || "R"}
          </span>
          <div className="shipment-hero-copy">
            <span className="shipment-hero-kicker">
              {brand} · {department}
            </span>
            <h2>{title}</h2>
            {sourceHref && (
              <a
                className="shipment-hero-source"
                href={sourceHref}
                target="_blank"
                rel="noreferrer"
              >
                <ArrowSquareOut size={15} /> Открыть исходный лист
              </a>
            )}
          </div>
        </div>
        <span className="shipment-hero-tag">
          Поставка {brand === "RITM" ? "RITM" : `на ${brand}`}
        </span>
        {actions && <div className="shipment-hero-actions">{actions}</div>}
      </div>
      {children && <div className="shipment-hero-metrics">{children}</div>}
    </section>
  );
}
