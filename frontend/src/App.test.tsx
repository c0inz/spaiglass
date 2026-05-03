import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChatPage } from "./components/ChatPage";
import { SettingsProvider } from "./contexts/SettingsContext";

// Mock fetch globally
global.fetch = vi.fn();

describe("App Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock projects API response
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ projects: [] }),
    });
  });

  // The "/" → ProjectSelector test was removed when the relay started
  // intercepting bare /vm/<slug>/ and redirecting straight to a chat
  // (see relay/src/server.ts handler for /vm/:slug/, 2026-05-03).
  // ProjectSelector is no longer mounted; the SPA's "/" branch falls
  // through to RoleResolver which is the same path as any other URL.

  it("renders chat page when navigating to projects path", async () => {
    await act(async () => {
      render(
        <SettingsProvider>
          <MemoryRouter initialEntries={["/projects/test-path"]}>
            <Routes>
              <Route path="/projects/*" element={<ChatPage />} />
            </Routes>
          </MemoryRouter>
        </SettingsProvider>,
      );
    });

    await waitFor(() => {
      // Brand component splits into spans: Sp + <span>ai</span> + Glass
      expect(
        screen.getByText((_, node) => node?.textContent === "SpaiGlass"),
      ).toBeInTheDocument();
      expect(screen.getAllByText("/test-path").length).toBeGreaterThan(0);
    });
  });
});
