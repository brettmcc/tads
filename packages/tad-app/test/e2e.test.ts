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
      (1,    1.5,         1, 'alpha',    DATE '2026-01-01', 10),
      (2,    2.5,         2, 'it''s',    DATE '2026-01-02', 20),
      (3,    CAST(NULL AS DOUBLE), 3, 'say "hi"', DATE '2026-01-03', 30),
      (4,    4.5,         3, NULL,       NULL,              40),
      (NULL, 5.5,         5, 'gamma',    DATE '2026-02-01', 50),
      (6,    6.5,         5, 'alpha',    DATE '2026-03-01', 60)
    ) AS t(a, b, c, s, d, "has space")`);
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

test("command helpers, footer metrics, and column search render", async () => {
  const input = page.locator('[data-testid="command-input"]');
  await input.fill("sum has");
  await input.press("Tab");
  expect(await input.inputValue()).toBe("sum `has space`");
  await input.fill("");

  expect(
    await page.locator('[data-testid="command-break-button"]').isDisabled()
  ).toBe(true);

  const sizeText = await page
    .locator('[data-testid="footer-dataset-size"]')
    .textContent({ timeout: 30000 });
  expect(sizeText).toContain("Disk ");
  expect(sizeText).toContain("Memory ");

  await page.locator('[data-testid="activity-pivot"]').click();
  const search = page.locator('[data-testid="column-search-input"]');
  await search.waitFor({ timeout: 30000 });
  await search.fill("space");
  const rows = page.locator('[data-testid="column-selector-row"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="column-selector-row"]')
        .length === 1
  );
  expect(await rows.count()).toBe(1);
  expect(await rows.first().textContent()).toContain("has space");
  await page.locator('[data-testid="activity-pivot"]').click();
}, 90000);

test("browse updates the main grid", async () => {
  // all fixture columns (plus the record-count column) initially
  const initialHeaders = await headerNames();
  expect(initialHeaders).toEqual(
    expect.arrayContaining(["a", "b", "c", "s", "d", "has space"])
  );

  await runCommand("bro a b if c > 2");

  // grid re-renders with just the projected columns (plus the unnamed
  // Stata-style row-number column on the left)
  await page.waitForFunction(
    () => {
      const els = Array.from(
        document.querySelectorAll(".slick-header-column .slick-column-name")
      );
      const names = els
        .map((el) => (el.textContent ?? "").trim())
        .filter((nm) => nm.length > 0);
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

test("row numbers, row select, and cell-contents bar", async () => {
  // the filtered view (c > 2, 4 rows) numbers its rows 1..4
  await page.waitForSelector(".slick-cell.row-number-cell", {
    timeout: 30000,
  });
  const rowNums = await page.$$eval(".slick-cell.row-number-cell", (els) =>
    els.map((el) => (el.textContent ?? "").trim())
  );
  expect(rowNums.slice(0, 4)).toEqual(["1", "2", "3", "4"]);

  // clicking a data cell spells it out in the cell-contents bar and
  // mildly highlights its row stub and column header. With the frozen
  // row-number pane, data cells live in the right canvas; the first
  // visual row is the one positioned at top 0.
  await page.evaluate(() => {
    const canvas = document.querySelector(
      ".grid-canvas-top.grid-canvas-right"
    )!;
    const rows = Array.from(
      canvas.querySelectorAll(".slick-row")
    ) as HTMLElement[];
    const row0 = rows.find((r) => r.style.top === "0px")!;
    (row0.querySelector(".slick-cell") as HTMLElement).click();
  });
  await page.waitForFunction(
    () => {
      const label = document.querySelector(
        '[data-testid="cell-content-label"]'
      );
      const value = document.querySelector(
        '[data-testid="cell-content-value"]'
      );
      return (
        label != null &&
        (label.textContent ?? "").trim() === "a[1]" &&
        value != null &&
        (value.textContent ?? "").trim() === "3"
      );
    },
    undefined,
    { timeout: 30000 }
  );
  expect(
    await page.locator(".slick-cell.row-number-cell.row-stub-active").count()
  ).toBe(1);
  expect(
    await page.locator(".slick-header-column.col-header-active").count()
  ).toBe(1);

  // clicking a row number selects the entire row
  await page
    .locator(".slick-cell.row-number-cell", { hasText: "2" })
    .first()
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".slick-cell.selected").length >= 2,
    undefined,
    { timeout: 30000 }
  );

  // the row-number column is frozen: it renders in the left (pinned)
  // canvas so it stays in view during horizontal scrolling
  expect(
    await page.locator(".grid-canvas-left .slick-cell.row-number-cell").count()
  ).toBeGreaterThan(0);
}, 90000);

test("data source node labels carry the full path as a hover tooltip", async () => {
  const titles = await page.$$eval('[data-testid="ds-node-label"]', (els) =>
    els.map((el) => el.getAttribute("title") ?? "")
  );
  expect(titles.length).toBeGreaterThan(0);
  expect(titles.some((t) => t.endsWith("fixture.parquet"))).toBe(true);
}, 90000);

test("summarize appends a table to the results pane", async () => {
  await runCommand("sum a b if a >= 3");

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
  // b: N=2, mean 5.5, sd 1.414214, min 4.5, max 6.5
  expect(cellTexts.slice(0, 6)).toEqual([
    "a",
    "3",
    "4.333333",
    "1.527525",
    "3",
    "6",
  ]);
  expect(cellTexts.slice(6, 12)).toEqual([
    "b",
    "2",
    "5.5",
    "1.414214",
    "4.5",
    "6.5",
  ]);

  const input = page.locator('[data-testid="command-input"]');
  await input.press("PageUp");
  expect(await input.inputValue()).toBe("sum a b if a >= 3");
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
