/**
 * Assemble res/AppIcon.icns from PNG files.
 *
 * Modern .icns files may carry PNG-encoded payloads directly, so no
 * platform tooling (iconutil/png2icns) is needed. Expects the resized
 * PNGs to already exist (see genIcon.ps1, which produces them).
 *
 * Usage: node makeIcns.js <pngDir> <outIcnsPath>
 *   pngDir must contain icon_16.png, icon_32.png, ... icon_1024.png
 */
const fs = require("fs");
const path = require("path");

const TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
];

const [pngDir, outPath] = process.argv.slice(2);
if (!pngDir || !outPath) {
  console.error("usage: node makeIcns.js <pngDir> <outIcnsPath>");
  process.exit(1);
}

const chunks = TYPES.map(([type, size]) => {
  const png = fs.readFileSync(path.join(pngDir, `icon_${size}.png`));
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});

const body = Buffer.concat(chunks);
const fileHeader = Buffer.alloc(8);
fileHeader.write("icns", 0, "ascii");
fileHeader.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(outPath, Buffer.concat([fileHeader, body]));
console.log(`wrote ${outPath} (${body.length + 8} bytes)`);
