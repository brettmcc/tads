import * as reltab from "reltab";
export const columnSum = (
  tableData: reltab.TableRep,
  columnId: string
): number => {
  var sum: number = 0;

  for (var i = 0; i < tableData.rowData.length; i++) {
    sum += Number(tableData.rowData[i][columnId]);
  }
  return sum;
};

/**
 * Rows of an unordered query result in a stable order, so snapshots
 * don't depend on DuckDB's (nondeterministic) GROUP BY output order.
 */
export const sortedRows = (table: reltab.TableRep): reltab.Row[] => {
  const key = (row: reltab.Row) =>
    JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return [...table.rowData].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
  );
};
