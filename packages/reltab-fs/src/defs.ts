/**
 * Lightweight definitions with no dependency on reltab-duckdb, so
 * consumers (like the Tad app's main process) can use them without
 * loading the DuckDB native library.
 */

export const dataFileExtensions = ["csv", "tsv", "parquet", "csv.gz", "tsv.gz"];

const ipfsPathPrefixes = ["s3://", "https://"];
export const isIPFSPath = (pathname: string): boolean => {
  for (const prefix of ipfsPathPrefixes) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};
