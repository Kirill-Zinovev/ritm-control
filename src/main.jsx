import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { CloudAuthGate } from "./CloudAuth";
import { installManagerSessionFetch } from "./managerSession";
import { PageErrorBoundary, trackPageLoadErrors } from "./PageErrorBoundary";
import "./styles.css";

installManagerSessionFetch();
trackPageLoadErrors();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PageErrorBoundary title="Не удалось открыть RITM">
      <CloudAuthGate>
        <App />
      </CloudAuthGate>
    </PageErrorBoundary>
  </React.StrictMode>,
);
