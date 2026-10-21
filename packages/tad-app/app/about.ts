import os from "os";
import electron, { BrowserWindow, MessageBoxOptions } from "electron";
import { duckDbVersion } from "./dataProviders";
import { portableDataDir } from "./portable";

// set by webpack.config.js at build time
declare const TADS_BUILD_COMMIT: string;
declare const TADS_BUILD_DATE: string;

const app = electron.app;
const dialog = electron.dialog;

const COPY_BUTTON = 0;
const OK_BUTTON = 1;

/** One "Name: value" line per component of the running build. */
const versionDetails = async (): Promise<string> => {
  let duckDb: string;
  try {
    duckDb = await duckDbVersion();
  } catch (e) {
    duckDb = "unavailable";
  }
  return [
    `Commit: ${TADS_BUILD_COMMIT}`,
    `Build date: ${TADS_BUILD_DATE}`,
    `Electron: ${process.versions.electron}`,
    `Chromium: ${process.versions.chrome}`,
    `Node.js: ${process.versions.node}`,
    `V8: ${process.versions.v8}`,
    `DuckDB: ${duckDb}`,
    `OS: ${os.type()} ${os.arch()} ${os.release()}`,
    `Portable mode: ${portableDataDir != null ? "yes" : "no"}`,
  ].join("\n");
};

/**
 * Show the Tads version and the versions of its components, with a Copy
 * button that puts the same text on the clipboard for bug reports.
 */
export const showAboutDialog = async (parent?: BrowserWindow) => {
  const message = `Tads ${app.getVersion()}`;
  const detail = await versionDetails();
  const options: MessageBoxOptions = {
    type: "info",
    title: "About Tads",
    message,
    detail,
    buttons: ["Copy", "OK"],
    defaultId: OK_BUTTON,
    cancelId: OK_BUTTON,
    noLink: true,
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response === COPY_BUTTON) {
    electron.clipboard.writeText(`${message}\n${detail}`);
  }
};
