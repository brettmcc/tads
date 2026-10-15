import { SQLDialect } from "./dialect";
import { DuckDBDialect } from "./dialects/DuckDBDialect";

export const dialects: { [dialectName: string]: SQLDialect } = {
  duckdb: DuckDBDialect,
};

export { DuckDBDialect };
