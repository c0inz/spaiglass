import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { ChatPage } from "./components/ChatPage";
import { RoleResolver } from "./components/RoleResolver";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsProvider } from "./contexts/SettingsContext";

// Routing notes:
//   /           — used to mount ProjectSelector (Server+Directory landing
//                 picker). Deprecated 2026-05-03: the relay now redirects
//                 /vm/<slug>/ straight to /vm/<slug>/<firstProject>/ so
//                 this route is unreachable in practice. Falling through
//                 to RoleResolver is harmless (it bounces to the picker
//                 sequence) but in the redirect-driven world this branch
//                 should not fire.
//   /projects/* — legacy direct-mount path, kept for back-compat.
//   *           — RoleResolver resolves __SG context and renders ChatPage.
function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <Router
          basename={(window as Window & { __SG_BASE?: string }).__SG_BASE || ""}
        >
          <Routes>
            <Route path="/projects/*" element={<ChatPage />} />
            <Route path="*" element={<RoleResolver />} />
          </Routes>
        </Router>
      </SettingsProvider>
    </ErrorBoundary>
  );
}

export default App;
