/**
 * updater.js
 *
 * Based on code snippet from electron-builder docs found here:
 * https://github.com/electron-userland/electron-builder/blob/master/docs/encapsulated%20manual%20update%20via%20menu.js
 */
import { dialog, BrowserWindow, MenuItem } from "electron";
import type { AppUpdater } from "electron-updater";

let updater: MenuItem | null;

// electron-updater is one of the slowest requires in the main process and
// is only needed when the user picks "Check for Updates", so load it (and
// attach its listeners) lazily on first use.
let _autoUpdater: AppUpdater | null = null;

function getAutoUpdater(): AppUpdater {
  if (_autoUpdater == null) {
    const { autoUpdater } =
      require("electron-updater") as typeof import("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.on("error", (event, error) => {
      dialog.showErrorBox(
        "Error: ",
        error == null ? "unknown" : (error.stack || error).toString()
      );
    });
    autoUpdater.on("update-available", () => {
      const buttonIndex = dialog.showMessageBoxSync({
        type: "info",
        title: "Found Updates",
        message:
          "A new release of Tads is available. Do you want to update now?",
        buttons: ["Yes", "No"],
      });
      if (buttonIndex === 0) {
        autoUpdater.downloadUpdate();
      } else {
        updater!.enabled = true;
        updater = null;
      }
    });
    autoUpdater.on("update-not-available", () => {
      dialog.showMessageBox({
        title: "No Updates",
        message: "Current version is up-to-date.",
      });
      updater!.enabled = true;
      updater = null;
    });
    autoUpdater.on("update-downloaded", () => {
      dialog.showMessageBoxSync({
        title: "Install Updates",
        message: "Update downloaded, will  update...",
      });
      autoUpdater.quitAndInstall();
    });
    _autoUpdater = autoUpdater;
  }
  return _autoUpdater;
}

// export this to MenuItem click callback
export function checkForUpdates(
  menuItem: MenuItem,
  focusedWindow: BrowserWindow
) {
  console.log("updater.checkForUpdates");
  updater = menuItem;
  updater.enabled = false;
  getAutoUpdater().checkForUpdates();
}
