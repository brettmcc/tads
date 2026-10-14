/**
 * Turn DuckDB's terse parquet format errors into an explanation of what
 * is actually wrong with the file.
 *
 * DuckDB validates a parquet file only by its last 8 bytes (4-byte footer
 * length + "PAR1" magic), so "No magic bytes found at end of file" covers
 * everything from an interrupted download to a CSV with a .parquet
 * extension. Reading the file's first and last bytes lets us say which,
 * and the messages only claim what the bytes show.
 */
import * as fs from "fs";

const MAGIC = "PAR1";
const ENCRYPTED_MAGIC = "PARE";

// how much of each end of the file we read to classify it
const HEAD_BYTES = 512;
const TAIL_BYTES = 64 * 1024;

// DuckDB raises these for a file it could open and read but whose
// contents it rejects; path, permission and network errors are other
// types ("IO Error", "HTTP Error", ...) and pass through untouched.
const CONTENT_ERROR = /\b(Invalid Input Error|Invalid Error):/;

// Errors from parsing the footer metadata. When the file's start and end
// markers are intact, only these justify calling the file damaged: other
// content errors on such a file (an unsupported codec or type, say) say
// nothing about damage, so DuckDB's own message is clearer.
const METADATA_PARSE_ERROR =
  /Footer length error|TProtocolException|don't know what type|Negative size|Size limit|Depth limit/;

const INCOMPLETE_CAUSES =
  "This usually means the file is incomplete: a download or copy may have " +
  "been interrupted, or the program writing the file may still be running " +
  "or may have stopped partway.";

const startsWith = (buf: Buffer, sig: string | number[]): boolean => {
  const bytes = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  return buf.length >= bytes.length && buf.subarray(0, bytes.length).equals(bytes);
};

/* first non-blank line of a text file, trimmed for display */
const firstLine = (text: string, maxLen = 80): string => {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/[\x00-\x1f\x7f]/g, " ");
  return clean.length > maxLen ? clean.slice(0, maxLen) + "…" : clean;
};

const looksLikeText = (buf: Buffer): boolean => {
  if (buf.length === 0 || buf.includes(0)) {
    return false;
  }
  let printable = 0;
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x20) {
      printable++;
    }
  }
  return printable / buf.length > 0.95;
};

/**
 * If `tail` holds a complete parquet ending ("<footer length>PAR1") somewhere
 * before its last byte, return how many bytes follow it. The footer length
 * must fit in the file, which rules out "PAR1" bytes inside column data.
 */
const findTrailingBytes = (tail: Buffer, fileSize: number): number | null => {
  if (tail.length < 13) {
    return null;
  }
  const tailStart = fileSize - tail.length;
  let pos = tail.lastIndexOf(MAGIC, tail.length - 5, "latin1");
  while (pos >= 4) {
    const end = tailStart + pos + 4; // file offset just past this magic
    const footerLen = tail.readUInt32LE(pos - 4);
    if (footerLen > 0 && footerLen + 12 <= end) {
      return fileSize - end;
    }
    pos = tail.lastIndexOf(MAGIC, pos - 1, "latin1");
  }
  return null;
};

/* what a non-parquet file actually is, as a phrase completing "it is ..." */
const identifyOtherFormat = (head: Buffer): string | null => {
  if (startsWith(head, [0x1f, 0x8b])) {
    return "gzip-compressed data. If it holds a compressed Parquet file, decompress it first";
  }
  if (startsWith(head, "PK\x03\x04") || startsWith(head, "PK\x05\x06")) {
    return "a zip archive (Excel .xlsx workbooks are also stored this way)";
  }
  if (startsWith(head, "ARROW1")) {
    return "an Arrow IPC / Feather file";
  }
  if (startsWith(head, "FEA1")) {
    return "a Feather (version 1) file";
  }
  if (startsWith(head, "ORC")) {
    return "an ORC file";
  }
  if (startsWith(head, "Obj\x01")) {
    return "an Avro file";
  }
  if (startsWith(head, "SQLite format 3\x00")) {
    return "a SQLite database";
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) {
    return "a legacy Microsoft Office file (such as an .xls workbook)";
  }
  if (startsWith(head, "%PDF")) {
    return "a PDF document";
  }
  if (startsWith(head, "<stata_dta>")) {
    return "a Stata dataset (.dta)";
  }

  // text formats: skip a UTF-8 byte-order mark and leading whitespace
  const text = head.toString("utf8").replace(/^﻿/, "");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("version https://git-lfs")) {
    return (
      "a Git LFS pointer: a small placeholder that stands in for the real " +
      "file in a Git repository. Fetching the actual file (for example with " +
      "`git lfs pull`) replaces it"
    );
  }
  if (/^<(!doctype\s+html|html)/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
    const title = /<title[^>]*>([^<]*)/i.exec(text);
    const titleNote = title && title[1].trim() ? ` titled "${firstLine(title[1])}"` : "";
    return (
      `a web page (HTML)${titleNote}. If it came from a website, the site ` +
      "may have sent an error or sign-in page instead of the data"
    );
  }
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) {
    return `XML or other markup text, starting with: ${firstLine(trimmed)}`;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return `JSON text, starting with: ${firstLine(trimmed)}`;
  }
  if (looksLikeText(head)) {
    return `a plain text file (for example CSV), whose first line is: ${firstLine(trimmed)}`;
  }
  return null;
};

const DAMAGED_METADATA =
  "The file ends like a Parquet file, but the metadata Parquet keeps at the " +
  "end of the file can't be read, so the file is damaged. It may have been " +
  "altered in transfer or written by a program that failed.";

/**
 * Explain why a file of `fileSize` bytes, whose first and last bytes are
 * `head` and `tail`, is not a readable parquet file. `tail` may overlap
 * `head` (or be the whole file) when the file is small. Returns null when
 * the file ends with an intact parquet marker, the only thing DuckDB
 * checks before parsing the footer: the bytes then show nothing wrong at
 * this level.
 */
export const describeParquetProblem = (
  fileSize: number,
  head: Buffer,
  tail: Buffer
): string | null => {
  if (fileSize === 0) {
    return (
      "The file is empty (0 bytes). It may still be being created, or " +
      "whatever produced it stopped before writing any data."
    );
  }
  const headMagic = head.subarray(0, 4).toString("latin1");
  const tailMagic = tail.subarray(Math.max(0, tail.length - 4)).toString("latin1");

  if (headMagic === ENCRYPTED_MAGIC || tailMagic === ENCRYPTED_MAGIC) {
    return "This Parquet file is encrypted, and Tads can't open encrypted Parquet files.";
  }

  if (tailMagic === MAGIC && fileSize >= 12) {
    return null;
  }

  if (headMagic === MAGIC) {
    if (fileSize < 12) {
      return (
        `The file starts like a Parquet file but is only ${fileSize} bytes ` +
        "long, too short to hold any data. " +
        INCOMPLETE_CAUSES
      );
    }
    const extra = findTrailingBytes(tail, fileSize);
    if (extra !== null) {
      const n = extra.toLocaleString("en-US");
      return (
        `The file holds a complete Parquet file followed by ${n} extra ` +
        `byte${extra === 1 ? "" : "s"}. Parquet readers require the file ` +
        "to end exactly where the Parquet data ends, so something appended " +
        "data to it after it was written."
      );
    }
    const zeroTail = tail.length > 0 && tail.every((b) => b === 0);
    const endDescription = zeroTail
      ? "its end is filled with zeros instead of the footer Parquet writes last"
      : "its end is missing: Parquet writes a footer at the very end of the " +
        "file, and this file doesn't have one";
    return `The file starts like a Parquet file, but ${endDescription}. ${INCOMPLETE_CAUSES}`;
  }

  const other = identifyOtherFormat(head);
  if (other !== null) {
    return `This isn't a Parquet file: it is ${other}.`;
  }
  return (
    "This doesn't look like a Parquet file: Parquet files start and end " +
    'with the marker "PAR1", and this file has neither. It may be in ' +
    "another format, or badly damaged."
  );
};

const readFileEnds = (
  filePath: string
): { size: number; head: Buffer; tail: Buffer } => {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(TAIL_BYTES, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return { size, head, tail };
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Given the error DuckDB raised while reading `filePath` as parquet,
 * return an Error whose message explains the problem in plain terms,
 * keeping DuckDB's own message as a detail line. Returns `err` itself
 * when it isn't about the file's contents, when the file's bytes don't
 * account for it, or when the file can't be inspected (e.g. a remote URL).
 */
export const explainParquetError = (filePath: string, err: unknown): unknown => {
  const msg = String((err as any)?.message ?? err);
  if (!CONTENT_ERROR.test(msg)) {
    return err;
  }
  let problem: string | null;
  try {
    const { size, head, tail } = readFileEnds(filePath);
    problem = describeParquetProblem(size, head, tail);
  } catch (readErr) {
    console.log("explainParquetError: could not inspect file: ", readErr);
    return err;
  }
  if (problem === null) {
    if (!METADATA_PARSE_ERROR.test(msg)) {
      return err;
    }
    problem = DAMAGED_METADATA;
  }
  // DuckDB appends the failing SQL ("LINE 1: CREATE OR REPLACE VIEW ...");
  // only its first line is useful to a user
  const detail = msg.split("\n")[0].trim();
  const explained = new Error(
    `${problem}\n\nFile: ${filePath}\nDetails: ${detail}`
  );
  (explained as any).cause = err;
  return explained;
};
