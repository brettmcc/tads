import { profLog } from "./startupProf";

let providersPromise: Promise<void> | null = null;

/**
 * Load and register the reltab data source providers. Requiring
 * reltab-duckdb loads the DuckDB native library, which is the most
 * expensive require in the main process, so it's deferred off the
 * startup critical path: kicked off in the background once the first
 * window is up, and awaited in initMainAsync before any data requests
 * are served.
 */
export function loadDataProviders(): Promise<void> {
  if (providersPromise == null) {
    providersPromise = new Promise((resolve, reject) => {
      // setImmediate so a fire-and-forget caller doesn't block the
      // current tick with the synchronous native-library load
      setImmediate(() => {
        try {
          require("reltab-duckdb");
          require("reltab-fs");
          profLog("data providers loaded");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  return providersPromise;
}
