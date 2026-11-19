import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Button, Dialog } from "./ui";
const Context = createContext<{
  setDirty(value: boolean): void;
  request(action: () => void): void;
}>({ setDirty: () => {}, request: (action) => action() });
export function DraftGuard({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  return (
    <Context.Provider
      value={{
        setDirty,
        request: (action) => {
          if (dirty) setPending(() => action);
          else action();
        },
      }}
    >
      {children}
      {pending ? (
        <Dialog
          title="В форме есть незаписанное количество"
          onClose={() => setPending(null)}
        >
          <div className="stack">
            <p>
              Остаться в форме или перейти без записи? На сервер эти данные ещё
              не отправлены.
            </p>
            <div className="actions">
              <Button onClick={() => setPending(null)}>Остаться в форме</Button>
              <Button
                onClick={() => {
                  const action = pending;
                  setPending(null);
                  setDirty(false);
                  action();
                }}
              >
                Перейти без записи
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Context.Provider>
  );
}
export const useDraftNavigation = () => useContext(Context).request;
export function useDirty(dirty: boolean) {
  const { setDirty } = useContext(Context);
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
}
