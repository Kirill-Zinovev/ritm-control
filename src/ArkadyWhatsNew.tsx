import * as Dialog from "@radix-ui/react-dialog";
import { Bell, CalendarDays, Sparkle, Tag, X } from "lucide-react";
import { Button } from "./ui";
import "./arkadyWhatsNew.css";

const highlights = [
  { Icon: CalendarDays, label: "Сроки и задержки" },
  { Icon: Tag, label: "Карточки WB и этикетки" },
  { Icon: Bell, label: "Задачи и напоминания" },
];

type ArkadyWhatsNewProps = {
  open: boolean;
  onClose: () => void;
  onOpenArkady: () => void;
};

export function ArkadyWhatsNew({ open, onClose, onOpenArkady }: ArkadyWhatsNewProps) {
  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay arkady-whats-new__overlay" />
        <Dialog.Content className="modal-content arkady-whats-new">
          <div className="arkady-whats-new__copy">
            <p className="arkady-whats-new__label">
              <Sparkle size={24} fill="currentColor" aria-hidden="true" />
              Что нового
            </p>
            <Dialog.Title className="arkady-whats-new__title">
              Аркадий в «Поставках»
            </Dialog.Title>
            <Dialog.Description className="arkady-whats-new__description">
              Помогает менеджеру вести поставки
            </Dialog.Description>
            <ul className="arkady-whats-new__features">
              {highlights.map(({ Icon, label }) => (
                <li key={label}>
                  <Icon size={28} strokeWidth={1.9} aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
            <div className="arkady-whats-new__actions">
              <Button type="button" kind="primary" onClick={onOpenArkady}>
                Открыть Аркадия
              </Button>
              <Dialog.Close asChild>
                <Button type="button">Позже</Button>
              </Dialog.Close>
            </div>
          </div>
          <div className="arkady-whats-new__art" aria-hidden="true" />
          <Dialog.Close asChild>
            <button type="button" className="arkady-whats-new__close" aria-label="Закрыть окно">
              <X size={22} aria-hidden="true" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
