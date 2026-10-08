/**
 * Portable mode: when a folder named "data" sits next to the Tads executable,
 * keep everything Tads writes (Chromium profile and caches, install marker,
 * logs) in that folder instead of the per-user application data folder, so the
 * whole app can live on a USB stick or in a folder without being installed.
 * This is the Windows portable zip's layout; the installed app has no such
 * folder and is unaffected. Not used on macOS, where the executable is
 * inside the app bundle.
 *
 * The switch happens when this module is loaded, so main.ts imports it first:
 * electron-log asks Electron for the logs path as soon as it is loaded, and
 * that creates the default logs folder. For the same reason this module does
 * not import electron-log; main() calls usePortableLogFile once it has.
 */
import path from "path";
import fs from "fs";
import electron from "electron";
import type { ElectronLog } from "electron-log";

const app = electron.app;
const PORTABLE_DATA_DIRNAME = "data";

const findPortableDataDir = (): string | null => {
  if (process.platform === "darwin" || !app.isPackaged) {
    return null;
  }
  const dataDir = path.join(
    path.dirname(app.getPath("exe")),
    PORTABLE_DATA_DIRNAME
  );
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    return null;
  }
  return dataDir;
};

/** the portable data folder, or null when not running in portable mode */
export const portableDataDir = findPortableDataDir();

if (portableDataDir != null) {
  app.setPath("userData", portableDataDir);
  app.setAppLogsPath(path.join(portableDataDir, "logs"));
}

/**
 * In portable mode, write log files to the data folder: electron-log picks
 * its folder from the package name, not from userData.
 */
export const usePortableLogFile = (log: ElectronLog) => {
  if (portableDataDir == null) {
    return;
  }
  const logsDir = path.join(portableDataDir, "logs");
  log.transports.file.resolvePath = (variables) =>
    path.join(logsDir, variables.fileName ?? "main.log");
  log.info("portable mode: keeping user data in ", portableDataDir);
};
