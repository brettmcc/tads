/**
 * Smoke test for the PACKAGED Windows app (release/win-unpacked/Tads.exe):
 * opens a generated fixture parquet, runs a browse and a summarize
 * command, and verifies the grid, the results pane, and visible SQL.
 *
 * Usage: node tools/packagedSmoke.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron } = require("playwright-core");

async function writeFixtureParquet(target) {
  const { DuckDBInstance } = require("@duckdb/node-api");
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const duckTarget = target.replace(/\\/g, "/");
  await conn.run(`
    CREATE TABLE fixture AS
    SELECT * FROM (VALUES
      (1,    1.5,  1, 'alpha'),
      (2,    2.5,  2, 'it''s'),
      (3,    CAST(NULL AS DOUBLE), 3, 'say "hi"'),
      (4,    4.5,  3, NULL),
      (NULL, 5.5,  5, 'gamma'),
      (6,    6.5,  5, 'alpha')
    ) AS t(a, b, c, s)`);
  await conn.run(`COPY fixture TO '${duckTarget}' (FORMAT PARQUET)`);
  conn.disconnectSync();
}

async function main() {
  const exePath = path.resolve(__dirname, "..", "release", "win-unpacked", "Tads.exe");
  if (!fs.existsSync(exePath)) {
    throw new Error(`packaged app not found at ${exePath}; run electron-builder --dir first`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tad-packaged-smoke-"));
  const fixturePath = path.join(tmpDir, "fixture.parquet");
  await writeFixtureParquet(fixturePath);

  const app = await _electron.launch({
    executablePath: exePath,
    args: [fixturePath],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="command-input"]', { timeout: 60000 });
    await page.waitForSelector(".slick-header-column", { timeout: 60000 });
    console.log("packaged app opened fixture parquet");

    const input = page.locator('[data-testid="command-input"]');
    await input.fill("bro a b if c > 2");
    await input.press("Enter");
    await page.waitForFunction(
      () => {
        const names = Array.from(
          document.querySelectorAll(".slick-header-column .slick-column-name")
        ).map((el) => (el.textContent || "").trim());
        return names.length === 2 && names[0] === "a" && names[1] === "b";
      },
      undefined,
      { timeout: 30000 }
    );
    console.log("browse updated the grid (columns a, b)");

    await input.fill("sum a b if a >= 3");
    await input.press("Enter");
    await page.waitForSelector('[data-testid="results-pane"]', { timeout: 30000 });
    const cells = await page
      .locator('[data-testid="result-entry"]')
      .last()
      .locator("table.command-result-table tbody td")
      .allTextContents();
    const expected = ["a", "3", "4.333333", "1.527525", "3", "6"];
    for (let i = 0; i < expected.length; i++) {
      if (cells[i] !== expected[i]) {
        throw new Error(`summarize cell ${i}: expected '${expected[i]}', got '${cells[i]}'`);
      }
    }
    console.log("summarize values correct:", cells.slice(0, 6).join(", "));

    const sqlText = await page
      .locator('[data-testid="result-entry"]')
      .last()
      .locator('[data-testid="entry-sql"] pre')
      .textContent();
    if (!sqlText.includes("stddev_samp")) {
      throw new Error("generated SQL not visible in results entry");
    }
    console.log("generated SQL visible in results pane");
    console.log("PACKAGED SMOKE TEST PASSED");
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("PACKAGED SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
