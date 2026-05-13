import "./buffer-shim";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useApp } from "./lib/store";
import { initI18n } from "./i18n";
import "./styles.css";

if (import.meta.env.DEV) {
  (window as unknown as { __SKILLSAFE_DRIVER__?: unknown }).__SKILLSAFE_DRIVER__ = { useApp };
}

initI18n().then((lng) => {
  useApp.setState({ locale: lng });
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
