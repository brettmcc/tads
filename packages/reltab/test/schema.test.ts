import { DuckDBDialect, Schema } from "../src/reltab";

const schema = new Schema(DuckDBDialect, ["a", "b"], {
  a: { displayName: "a", columnType: "INTEGER" },
  b: { displayName: "b", columnType: "DOUBLE" },
});

test("columnIndex returns positional indices, 0 for the first column", () => {
  expect(schema.columnIndex("a")).toBe(0);
  expect(schema.columnIndex("b")).toBe(1);
  expect(schema.columnIndex("nope")).toBeUndefined();
});

// regression: columnIndex is 0 (falsy) for the first column, so
// membership tests must go through hasColumn
test("hasColumn is true for every schema column, including the first", () => {
  expect(schema.hasColumn("a")).toBe(true);
  expect(schema.hasColumn("b")).toBe(true);
  expect(schema.hasColumn("nope")).toBe(false);
});
