/**
 * DuckDB reports nearly every malformed parquet file as "No magic bytes
 * found at end of file". nativeParquetImport should instead explain what
 * the file's bytes show (incomplete, wrong format, trailing data, ...),
 * keeping DuckDB's message as a detail.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import * as reltab from "reltab";
import { DataSourceConnection, DbDataSource } from "reltab";
import * as reltabDuckDB from "../src/reltab-duckdb";
import { describeParquetProblem, explainParquetError } from "../src/parquetDiagnose";

let testCtx: DataSourceConnection;
let tmpDir: string;
let validParquet: Buffer;

const driverDb = () => ((testCtx as DbDataSource).db as reltabDuckDB.DuckDBDriver).db;

beforeAll(async () => {
  testCtx = await reltab.getConnection({
    providerName: "duckdb",
    resourceId: ":memory:",
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tad-parquet-diag-"));
  const validPath = path.join(tmpDir, "valid.parquet");
  const conn = await driverDb().connect();
  await conn.run(
    `COPY (SELECT i AS id, 'row ' || i AS label FROM range(50000) t(i))
     TO '${validPath.replace(/\\/g, "/")}' (FORMAT parquet)`
  );
  conn.disconnectSync();
  validParquet = fs.readFileSync(validPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* write `contents` as a .parquet file and return the import error message */
const importError = async (
  fileName: string,
  contents: Buffer | string
): Promise<string> => {
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, contents);
  try {
    await reltabDuckDB.nativeParquetImport(driverDb(), filePath);
  } catch (err: any) {
    return err.message;
  }
  throw new Error(`expected importing ${fileName} to fail`);
};

test("a valid parquet file still imports", async () => {
  const filePath = path.join(tmpDir, "valid.parquet");
  const tableName = await reltabDuckDB.nativeParquetImport(driverDb(), filePath);
  const rowCount = await testCtx.rowCount(reltab.tableQuery(tableName));
  expect(rowCount).toBe(50000);
});

test("a truncated file is reported as incomplete, with DuckDB's message as detail", async () => {
  const msg = await importError(
    "truncated.parquet",
    validParquet.subarray(0, validParquet.length >> 1)
  );
  expect(msg).toMatch(/^The file starts like a Parquet file, but its end is missing/);
  expect(msg).toContain("interrupted");
  expect(msg).toContain("still be running");
  expect(msg).toMatch(/File: .*truncated\.parquet/);
  expect(msg).toContain("Details: Invalid Input Error: No magic bytes found");
  // the failing SQL DuckDB appends is noise to a user
  expect(msg).not.toContain("CREATE OR REPLACE VIEW");
});

test("losing only the last byte is still reported as incomplete", async () => {
  const msg = await importError(
    "minus1.parquet",
    validParquet.subarray(0, validParquet.length - 1)
  );
  expect(msg).toMatch(/its end is missing/);
});

test("a zero-filled end is reported as incomplete", async () => {
  const half = validParquet.length >> 1;
  const msg = await importError(
    "zerofilled.parquet",
    Buffer.concat([validParquet.subarray(0, half), Buffer.alloc(validParquet.length - half)])
  );
  expect(msg).toMatch(/its end is filled with zeros/);
});

test("data appended after a complete file is counted", async () => {
  const msg = await importError(
    "appended.parquet",
    Buffer.concat([validParquet, Buffer.from("\n")])
  );
  expect(msg).toMatch(/complete Parquet file followed by 1 extra byte\./);

  const msg2 = await importError(
    "appended2.parquet",
    Buffer.concat([validParquet, Buffer.alloc(2000, 0x41)])
  );
  expect(msg2).toMatch(/followed by 2,000 extra bytes/);
});

test("damaged metadata between intact markers is reported as damaged", async () => {
  // scramble the footer metadata, leaving its length and the magic intact
  const scrambled = Buffer.from(validParquet);
  const footerLen = scrambled.readUInt32LE(scrambled.length - 8);
  scrambled.fill(0xff, scrambled.length - 8 - footerLen, scrambled.length - 8);
  const msg = await importError("scrambled.parquet", scrambled);
  expect(msg).toMatch(/^The file ends like a Parquet file/);
  expect(msg).toContain("damaged");

  const badFooterLen = Buffer.from(validParquet);
  badFooterLen.writeUInt32LE(0xfffffff0, badFooterLen.length - 8);
  const msg2 = await importError("footerlen.parquet", badFooterLen);
  expect(msg2).toMatch(/^The file ends like a Parquet file/);
  expect(msg2).toContain("Details: Invalid Input Error: Footer length error");
});

test("empty and tiny files", async () => {
  expect(await importError("empty.parquet", Buffer.alloc(0))).toMatch(
    /^The file is empty \(0 bytes\)/
  );
  expect(await importError("tiny.parquet", "PAR1abc")).toMatch(
    /starts like a Parquet file but is only 7 bytes long/
  );
});

test("files in other formats say what they are", async () => {
  const cases: [string, Buffer | string, RegExp][] = [
    ["csv.parquet", "id,name\n1,alpha\n2,beta\n", /plain text file \(for example CSV\), whose first line is: id,name/],
    [
      "page.parquet",
      "<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body>no</body></html>\n",
      /a web page \(HTML\) titled "403 Forbidden"/,
    ],
    [
      "s3error.parquet",
      '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code></Error>',
      /XML or other markup text, starting with: <\?xml/,
    ],
    ["api.parquet", '{"status":429,"message":"Too many requests"}', /JSON text, starting with: \{"status":429/],
    [
      "lfs.parquet",
      "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a2146\nsize 143384990\n",
      /Git LFS pointer/,
    ],
    ["gz.parquet", zlib.gzipSync(validParquet), /gzip-compressed data/],
    ["zip.parquet", Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(64, 1)]), /zip archive/],
    [
      "arrow.parquet",
      Buffer.concat([Buffer.from("ARROW1\0\0", "latin1"), Buffer.alloc(64, 7), Buffer.from("ARROW1", "latin1")]),
      /Arrow IPC \/ Feather file/,
    ],
    ["stata.parquet", "<stata_dta><header><release>119</release>", /Stata dataset \(\.dta\)/],
  ];
  for (const [name, contents, expected] of cases) {
    const msg = await importError(name, contents);
    expect(msg).toMatch(/^This isn't a Parquet file: it is /);
    expect(msg).toMatch(expected);
  }
});

test("unrecognized binary gets the generic explanation", async () => {
  const bytes = Buffer.alloc(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
  const msg = await importError("noise.parquet", bytes);
  expect(msg).toMatch(/^This doesn't look like a Parquet file/);
});

test("errors that aren't about the file's format pass through unchanged", async () => {
  const missing = path.join(tmpDir, "does-not-exist.parquet");
  let msg = "";
  try {
    await reltabDuckDB.nativeParquetImport(driverDb(), missing);
  } catch (err: any) {
    msg = err.message;
  }
  expect(msg).toMatch(/No files found that match the pattern/);
});

test("'PAR1' bytes inside column data aren't mistaken for an appended file", () => {
  // the tail contains "PAR1" preceded by an implausible footer length
  const tail = Buffer.concat([
    Buffer.alloc(100, 9),
    Buffer.from([0xff, 0xff, 0xff, 0x7f]),
    Buffer.from("PAR1", "latin1"),
    Buffer.alloc(100, 9),
  ]);
  const head = Buffer.from("PAR1", "latin1");
  expect(describeParquetProblem(10000, head, tail)).toMatch(/its end is missing/);
});

test("an encrypted footer is reported as encrypted", () => {
  const head = Buffer.from("PARE", "latin1");
  const tail = Buffer.concat([Buffer.alloc(20, 3), Buffer.from("PARE", "latin1")]);
  expect(describeParquetProblem(5000, head, tail)).toMatch(/encrypted/);
});

test("other errors on a file with intact markers keep DuckDB's message", () => {
  // e.g. a well-formed file using a codec DuckDB doesn't support
  const validPath = path.join(tmpDir, "valid.parquet");
  const err = new Error("Invalid Input Error: Failed to read file: unsupported compression codec");
  expect(explainParquetError(validPath, err)).toBe(err);
  // the same file with a footer parse error is called damaged
  const parseErr = new Error("Invalid Error: TProtocolException: Invalid data");
  expect((explainParquetError(validPath, parseErr) as Error).message).toMatch(
    /^The file ends like a Parquet file/
  );
});

test("path and IO errors pass through even for a malformed file", () => {
  const filePath = path.join(tmpDir, "io.parquet");
  fs.writeFileSync(filePath, "id,name\n1,a\n");
  const err = new Error('IO Error: Cannot open file "io.parquet": Permission denied');
  expect(explainParquetError(filePath, err)).toBe(err);
});
