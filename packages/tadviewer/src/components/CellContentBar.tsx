/**
 * Stata Browse-style cell-contents bar shown above the data grid: spells
 * out the focused cell in full ("varname[obs] = value"), so truncated
 * cell text can be read by clicking the cell.
 */
import * as he from "he";
import * as React from "react";
import * as reltab from "reltab";
import { AppState } from "../AppState";
import { ViewParams } from "../ViewParams";

export interface CellContentBarProps {
  appState: AppState;
}

/**
 * Plain-text rendering of a cell value for the cell-contents bar.
 *
 * Grid cell formatters produce HTML (he.encode escaping, anchor tags for
 * URLs) because SlickGrid renders via innerHTML; the bar renders through
 * React, which would show those entities literally. Strings pass through
 * raw; other values go through the column formatter with entities decoded.
 */
export const formatCellValueText = (
  viewParams: ViewParams,
  schema: reltab.Schema,
  columnId: string,
  cellVal: any
): string => {
  if (cellVal == null) {
    return "";
  }
  if (typeof cellVal === "string") {
    return cellVal;
  }
  if (schema.hasColumn(columnId)) {
    const cf = viewParams.getColumnFormatter(schema, columnId);
    const formatted = (cf as any)(cellVal);
    if (formatted != null) {
      return he.decode(formatted);
    }
  }
  return String(cellVal);
};

export const CellContentBar: React.FunctionComponent<CellContentBarProps> = ({
  appState,
}: CellContentBarProps) => {
  const fc = appState.focusedCell;
  const label =
    fc == null
      ? ""
      : fc.obs != null
      ? `${fc.columnDisplayName}[${fc.obs}]`
      : fc.columnDisplayName;
  return (
    <div className="cell-content-bar" data-testid="cell-content-bar">
      <div className="cell-content-label" data-testid="cell-content-label">
        {label}
      </div>
      <div className="cell-content-value" data-testid="cell-content-value">
        {fc?.value ?? ""}
      </div>
    </div>
  );
};
