import { Component, type ReactNode } from "react";
import { Button, Notice } from "./ui";

const preloadFailures = new WeakMap<object, boolean>();
const recoveryKey = "ritm-route-recovery";

function hasOpenDialog() {
  return document.querySelector('[role="dialog"], dialog[open]') !== null;
}

export function trackPageLoadErrors() {
  window.addEventListener("vite:preloadError", (event) => {
    const { payload } = event as Event & { payload?: unknown };
    if (
      payload instanceof Error &&
      /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css/i.test(payload.message)
    ) {
      preloadFailures.set(payload, !hasOpenDialog());
    }
  });
}

function reserveReload() {
  try {
    if (sessionStorage.getItem(recoveryKey) === import.meta.url) return false;
    sessionStorage.setItem(recoveryKey, import.meta.url);
    return true;
  } catch {
    return false;
  }
}

type Props = {
  children: ReactNode;
  title?: string;
  autoRecover?: boolean;
  quiet?: boolean;
};

export class PageErrorBoundary extends Component<
  Props,
  { failed: boolean; error: Error | null }
> {
  state: { failed: boolean; error: Error | null } = { failed: false, error: null };
  private reloadTimer?: number;

  static getDerivedStateFromError(error: Error) {
    return { failed: true, error };
  }

  componentDidCatch(error: Error) {
    if (!this.props.autoRecover || !preloadFailures.get(error)) return;
    this.reloadTimer = window.setTimeout(() => {
      if (this.props.autoRecover && !hasOpenDialog() && reserveReload()) {
        location.reload();
      }
    }, 100);
  }

  componentWillUnmount() {
    window.clearTimeout(this.reloadTimer);
  }

  render() {
    const { failed, error } = this.state;
    if (!failed) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <section className="panel" role="alert">
        <Notice tone="warning">
          <strong>{this.props.title || "Не удалось открыть раздел"}</strong>
        </Notice>
        <Button kind="primary" onClick={() => {
          window.clearTimeout(this.reloadTimer);
          if (error && preloadFailures.has(error)) location.reload();
          else this.setState({ failed: false, error: null });
        }}>
          Повторить
        </Button>
      </section>
    );
  }
}
