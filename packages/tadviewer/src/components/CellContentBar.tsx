/**
 * Stata Browse-style cell-contents bar shown above the data grid: spells
 * out the focused cell in full ("varname[obs] = value"), so truncated
 * cell text can be read by clicking the cell.
 */
import * as React from "react";
import { AppState } from "../AppState";

export interface CellContentBarProps {
  appState: AppState;
}

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
