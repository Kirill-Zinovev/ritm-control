import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { CloudAuthGate } from "./CloudAuth";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CloudAuthGate>
      <App />
    </CloudAuthGate>
  </React.StrictMode>,
);
