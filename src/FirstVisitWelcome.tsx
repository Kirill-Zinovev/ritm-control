import { useState } from "react";
import { CaretRight, ChartBar, CheckCircle, Truck } from "./icons";
import "./FirstVisitWelcome.css";

export default function FirstVisitWelcome({
  identity,
  onOpen,
}: {
  identity: string;
  onOpen: () => void;
}) {
  const key = "ritm-welcome-v1:" + identity;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "done";
    } catch {
      return false;
    }
  });
  const close = () => {
    try {
      localStorage.setItem(key, "done");
    } catch {}
    setOpen(false);
  };
  if (!open) return null;

  return (
    <div className="welcome-overlay">
      <div
        className="welcome-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        aria-describedby="welcome-description"
      >
        <div className="welcome-content">
          <div className="welcome-brand">
            RITM<span>/</span>
          </div>
          <h2 id="welcome-title">
            Добро пожаловать
            <br />в RITM
          </h2>
          <p id="welcome-description">
            Всё, что нужно для работы с поставками и производством, собрано в
            одном месте.
          </p>
          <div className="welcome-features">
            <div>
              <Truck size={19} />
              <span>Создавайте поставки и задания</span>
            </div>
            <div>
              <ChartBar size={19} />
              <span>Следите за готовностью участков</span>
            </div>
            <div>
              <CheckCircle size={19} />
              <span>Находите ответы в инструкциях</span>
            </div>
          </div>
          <div className="welcome-actions">
            <button
              className="welcome-primary"
              type="button"
              onClick={() => {
                close();
                onOpen();
              }}
            >
              Открыть обучение <CaretRight size={17} />
            </button>
            <button className="welcome-skip" type="button" onClick={close}>
              Позже
            </button>
          </div>
          <small className="welcome-hint">
            К обучению можно вернуться в любое время.
          </small>
        </div>
        <div className="welcome-visual" aria-hidden="true">
          <img src="/images/welcome-ritm.png" alt="" />
        </div>
      </div>
    </div>
  );
}
