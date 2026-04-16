import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
// Must run before any @monaco-editor/react usage so the loader uses the
// bundled Monaco instance instead of trying to pull it from the jsdelivr CDN
// (which the strict CSP blocks). See monaco-setup.ts for the full why.
import "./monaco-setup.ts";
import App from "./App.tsx";

// PWA service worker — register from the bundle so it's covered by
// the relay's CSP 'self' directive (no nonce needed).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
