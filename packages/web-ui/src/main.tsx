import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppStateProvider } from "./AppStateContext.tsx";
import { AppErrorBoundary } from "./AppErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </AppErrorBoundary>
  </React.StrictMode>
);
