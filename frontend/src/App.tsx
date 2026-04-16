import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { ProjectSelector } from "./components/ProjectSelector";
import { ChatPage } from "./components/ChatPage";
import { RoleResolver } from "./components/RoleResolver";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsProvider } from "./contexts/SettingsContext";

function App() {
  return (
    <ErrorBoundary>
    <SettingsProvider>
      <Router
        basename={(window as Window & { __SG_BASE?: string }).__SG_BASE || ""}
      >
        <Routes>
          <Route path="/" element={<ProjectSelector />} />
          <Route path="/projects/*" element={<ChatPage />} />
          <Route path="*" element={<RoleResolver />} />
        </Routes>
      </Router>
    </SettingsProvider>
    </ErrorBoundary>
  );
}

export default App;
