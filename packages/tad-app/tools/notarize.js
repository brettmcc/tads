const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appleId = process.env.APPLEID;
  if (!appleId) {
    console.warn(
      "notarize.js: APPLEID env var not set; skipping notarization (unsigned build). Set APPLEID and APPLEIDPASS to notarize."
    );
    return;
  }

  return await notarize({
    appBundleId: "com.tadstata.tads",
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword: process.env.APPLEIDPASS,
    teamId: "VPS8BQAV8D",
  });
};
