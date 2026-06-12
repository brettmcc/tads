/**
 * Electron end-to-end smoke test for the Stata command bar.
 *
 * Launches the built desktop app (run `npm run build-dev` or build-prod
 * in this package first) on a generated fixture Parquet file, then:
 *  - executes a browse command and verifies the grid updates,
 *  - executes a summarize command and verifies the results pane content,
 *  - toggles the results pane,
 *  - verifies the generated SQL is visible for every command.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  _electron,
  ElectronApplication,
  Page,
} from "playwright-core";

// the electron package's export is the path to the electron binary when
// required from plain Node:
const electronPath: string = require("electron") as unknown as string;

const appDir = path.resolve(__dirname, "..");

let tmpDir: string;
let fixturePath: string;
let app: ElectronApplication;
let page: Page;

async function writeFixtureParquet(target: string): Promise<void> {
  const { DuckDBInstance } = require("@duckdb/node-api");
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  // forward slashes keep the path literal simple for DuckDB
  const duckTarget = target.replace(/\\/g, "/");
  await conn.run(`
    CREATE TABLE fixture AS
    SELECT * FROM (VALUES
      (1,    1.5,         1, 'alpha',    DATE '2026-01-01'),
      (2,    2.5,         2, 'it''s',    DATE '2026-01-02'),
      (3,    CAST(NULL AS DOUBLE), 3, 'say "hi"', DATE '2026-01-03'),
      (4,    4.5,         3, NULL,       NULL),
      (NULL, 5.5,         5, 'gamma',    DATE '2026-02-01'),
      (6,    6.5,         5, 'alpha',    DATE '2026-03-01')
    ) AS t(a, b, c, s, d)`);
  await conn.run(
    `COPY fixture TO '${duckTarget}' (FORMAT PARQUET)`
  );
  conn.disconnectSync();
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tad-e2e-"));
  fixturePath = path.join(tmpDir, "fixture.parquet");
  await writeFixtureParquet(fixturePath);

  app = await _electron.launch({
    executablePath: electronPath,
    args: [".", "--foreground", fixturePath],
    cwd: appDir,
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="command-input"]', {
    timeout: 60000,
  });
  // wait for the grid to render the fixture columns
  await page.waitForSelector(".slick-header-column", { timeout: 60000 });
}, 120000);

afterAll(async () => {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runCommand(cmd: string): Promise<void> {
  const input = page.locator('[data-testid="command-input"]');
  await input.fill(cmd);
  await input.press("Enter");
}

async function headerNames(): Promise<string[]> {
  return page.$$eval(".slick-header-column .slick-column-name", (els) =>
    els.map((el) => (el.textContent ?? "").trim())
  );
}

test("browse updates the main grid", async () => {
  // all fixture columns (plus the record-count column) initially
  const initialHeaders = await headerNames();
  expect(initialHeaders).toEqual(
    expect.arrayContaining(["a", "b", "c", "s", "d"])
  );

  await runCommand("bro a b if c > 2");

  // grid re-renders with just the projected columns
  await page.waitForFunction(
    () => {
      const els = Array.from(
        document.querySelectorAll(".slick-header-column .slick-column-name")
      );
      const names = els.map((el) => (el.textContent ?? "").trim());
      return names.length === 2 && names[0] === "a" && names[1] === "b";
    },
    undefined,
    { timeout: 30000 }
  );

  // footer reflects the filtered row count: 4 of 6 rows match c > 2
  await page.waitForFunction(
    () => {
      const footer = document.querySelector(".footer");
      return (
        footer != null &&
        (footer.textContent ?? "").indexOf("4 (6 Total) Rows") >= 0
      );
    },
    undefined,
    { timeout: 30000 }
  );

  // browse appends a results entry without opening the pane
  expect(await page.locator('[data-testid="results-pane"]').count()).toBe(0);
}, 90000);

test("summarize appends a table to the results pane", async () => {
  await runCommand("sum a b if c > 2");

  await page.waitForSelector('[data-testid="results-pane"]', {
    timeout: 30000,
  });
  const entries = page.locator('[data-testid="result-entry"]');
  await entries.last().waitFor({ timeout: 30000 });
  expect(await entries.count()).toBe(2); // browse + summarize

  const lastEntry = entries.last();
  const cellTexts = await lastEntry
    .locator("table.command-result-table tbody td")
    .allTextContents();
  // a: N=3, mean 4.333333, sd 1.527525, min 3, max 6
  // b: N=3, mean 5.5, sd 1, min 4.5, max 6.5
  expect(cellTexts.slice(0, 6)).toEqual([
    "a",
    "3",
    "4.333333",
    "1.527525",
    "3",
    "6",
  ]);
  expect(cellTexts.slice(6, 12)).toEqual(["b", "3", "5.5", "1", "4.5", "6.5"]);
}, 90000);

test("generated SQL is visible for every command", async () => {
  const entries = page.locator('[data-testid="result-entry"]');
  const count = await entries.count();
  expect(count).toBe(2);

  // browse entry SQL
  const browseSql = entries.nth(0).locator('[data-testid="entry-sql"]');
  await browseSql.locator("summary").click();
  const browseSqlText = await browseSql.locator("pre").textContent();
  expect(browseSqlText).toContain('"a"');
  expect(browseSqlText).toContain('"c">2');

  // summarize entry SQL
  const sumSql = entries.nth(1).locator('[data-testid="entry-sql"]');
  await sumSql.locator("summary").click();
  const sumSqlText = await sumSql.locator("pre").textContent();
  expect(sumSqlText).toContain("stddev_samp");
  expect(sumSqlText).toContain('count("a") AS n');
}, 60000);

test("results pane toggles via the visible button", async () => {
  expect(await page.locator('[data-testid="results-pane"]').count()).toBe(1);
  await page.locator('[data-testid="results-toggle-button"]').click();
  expect(await page.locator('[data-testid="results-pane"]').count()).toBe(0);
  await page.locator('[data-testid="results-toggle-button"]').click();
  expect(await page.locator('[data-testid="results-pane"]').count()).toBe(1);
  // history is preserved across toggles (append-only)
  expect(await page.locator('[data-testid="result-entry"]').count()).toBe(2);
}, 60000);

test("errors surface near the input and in the results log", async () => {
  await runCommand("sum bogus");
  await page.waitForSelector('[data-testid="command-bar-error"]', {
    timeout: 30000,
  });
  const errText = await page
    .locator('[data-testid="command-bar-error"]')
    .textContent();
  expect(errText).toContain("unknown variable 'bogus'");
  // typed command preserved for correction
  expect(
    await page.locator('[data-testid="command-input"]').inputValue()
  ).toBe("sum bogus");
  expect(await page.locator('[data-testid="result-entry"]').count()).toBe(3);
}, 60000);
