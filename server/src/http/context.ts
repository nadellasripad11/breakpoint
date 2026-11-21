import type { Config } from '../config.ts';
import type { Fetcher } from '../auth/google.ts';
import type { SessionRow, Store, User } from '../store/types.ts';

/** everything a route needs, injected so tests (and a future workers port) can swap any of it. */
export interface Deps {
  store: Store;
  config: Config;
  fetch: Fetcher;
  now: () => Date;
  newId: () => string;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    deps: Deps;
    user?: User;
    session?: SessionRow;
    /** true when the session came from the cookie (so csrf rules apply) */
    viaCookie?: boolean;
  };
}
