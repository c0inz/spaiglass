/**
 * Project display name — user-editable label stored in localStorage.
 *
 * Keyed by project basename (e.g. "OCMarketplace"). Returns the custom
 * display name if set, otherwise null (callers fall back to the real name).
 */

const PREFIX = "sg_project_display:";

export function getProjectDisplayName(projectBasename: string): string | null {
  try {
    return localStorage.getItem(PREFIX + projectBasename) || null;
  } catch {
    return null;
  }
}

export function setProjectDisplayName(
  projectBasename: string,
  displayName: string | null,
): void {
  try {
    if (displayName) {
      localStorage.setItem(PREFIX + projectBasename, displayName);
    } else {
      localStorage.removeItem(PREFIX + projectBasename);
    }
  } catch {
    // localStorage unavailable
  }
}
