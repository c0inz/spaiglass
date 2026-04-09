/**
 * Shared types for SGCleanRelay.
 */

import type { User } from "./db.ts";

export type RelayEnv = {
  Bindings: {
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    PUBLIC_URL: string;
    SESSION_SECRET: string;
  };
  Variables: {
    user: User | null;
  };
};
