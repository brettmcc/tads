/**
 * Lightweight definitions with no dependency on reltab-duckdb, so
 * consumers (like the Tad app's main process) can use them without
 * loading the DuckDB native library.
 */

export const dataFileExtensions = ["csv", "tsv", "parquet", "csv.gz", "tsv.gz"];

/**
 * The entry of `dataFileExtensions` that `fileName` ends with, or null if
 * it isn't a data file. Longest match wins, so `t.csv.gz` is a "csv.gz"
 * rather than a "gz" we don't know about.
 *
 * Matching on a suffix rather than on everything after the first '.' is
 * what lets compound names through: Spark writes parts as
 * `part-00000-<uuid>-c000.snappy.parquet`, whose first-dot "extension"
 * (`snappy.parquet`) is in no one's list.
 */
export const matchDataFileExtension = (fileName: string): string | null => {
  const lcName = fileName.toLowerCase();
  let match: string | null = null;
  for (const ext of dataFileExtensions) {
    const suffix = "." + ext;
    if (
      lcName.length > suffix.length &&
      lcName.endsWith(suffix) &&
      (match === null || ext.length > match.length)
    ) {
      match = ext;
    }
  }
  return match;
};

/** true for s3:// and https:// URLs, which DuckDB reads over the network */
const remotePathPrefixes = ["s3://", "https://"];
export const isRemotePath = (pathname: string): boolean => {
  for (const prefix of remotePathPrefixes) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};
