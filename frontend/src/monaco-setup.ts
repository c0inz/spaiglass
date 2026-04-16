// Self-hosted Monaco setup. Must be imported before any use of
// @monaco-editor/react (see main.tsx).
//
// Why this file exists:
// The default @monaco-editor/loader config fetches Monaco from
// https://cdn.jsdelivr.net/npm/monaco-editor/... via a dynamically-injected
// <script> tag. Under the P8 strict CSP (`script-src 'self' 'nonce-...'`)
// that off-origin tag is blocked and the editor sits on "Loading..." forever.
//
// The fix: bundle monaco-editor via Vite, hand the instance to the React
// wrapper's loader, and spin up the web workers as Vite `?worker` imports so
// they're served same-origin. That keeps the CSP strict (no third-party CDN,
// no nonce relaxation) — we only need `worker-src 'self' blob:` on the relay
// side.
//
// Workers: we only edit markdown / json / txt in SpAIglass, so the core
// editor worker + the JSON language worker are enough. If we ever want TS /
// CSS / HTML editing, add those workers here and update the getWorker switch.

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { loader } from "@monaco-editor/react";

// Monaco reads MonacoEnvironment.getWorker when a model is created. Vite's
// `?worker` imports produce classes that yield same-origin Worker instances
// served from /assets/<hash>.js — CSP-friendly.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") {
      return new JsonWorker();
    }
    return new EditorWorker();
  },
};

// Hand the bundled instance to @monaco-editor/react. When `monaco` is set
// here, loader.init() resolves immediately with it and never tries to fetch
// the AMD loader from jsdelivr.
loader.config({ monaco });
