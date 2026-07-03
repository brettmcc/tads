import * as React from "react";
import * as actions from "../actions";
import { IndeterminateCheckbox } from "./IndeterminateCheckbox";
import { ViewParams } from "../ViewParams";
import * as reltab from "reltab";
import { StateRef } from "oneref";
import { AppState } from "../AppState";
import { useState } from "react";

export interface ColumnSelectorProps {
  schema: reltab.Schema;
  viewParams: ViewParams;
  onColumnClick?: (cid: string) => void;
  stateRef: StateRef<AppState>;
}

const shortenTypeName = (tn: string): string => {
  return tn === "integer" ? "int" : tn;
};

// default/limit widths (px) for the resizable column-name column
const NAME_COL_DEFAULT_WIDTH = 125;
const NAME_COL_MIN_WIDTH = 80;
const NAME_COL_MAX_WIDTH = 600;
const TYPE_COL_WIDTH = 69;
const CHECK_COL_WIDTH = 36;

export const ColumnSelector: React.FC<ColumnSelectorProps> = ({
  schema,
  viewParams,
  onColumnClick,
  stateRef,
}) => {
  const [searchText, setSearchText] = useState("");
  const [nameColWidth, setNameColWidth] = useState(NAME_COL_DEFAULT_WIDTH);

  const handleRowClick = (cid: string) => {
    if (onColumnClick) {
      onColumnClick(cid);
    }
  };

  // drag on the header handle resizes the name column; the tables grow
  // and scroll horizontally inside .column-selector-scroll
  const startNameColResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = nameColWidth;
    const onMove = (ev: MouseEvent) => {
      const w = startWidth + ev.clientX - startX;
      setNameColWidth(
        Math.min(NAME_COL_MAX_WIDTH, Math.max(NAME_COL_MIN_WIDTH, w))
      );
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const renderColumnRow = (cid: string) => {
    const displayName = schema.displayName(cid);
    const colTypeName = shortenTypeName(schema.columnType(cid).sqlTypeName);
    const isShown = viewParams.displayColumns.includes(cid);
    const isPivot = viewParams.vpivots.includes(cid);
    const isSort =
      viewParams.sortKey.findIndex((entry) => entry[0] === cid) !== -1;
    return (
      <tr key={cid} data-testid="column-selector-row">
        <td className="col-colName" onClick={(e) => handleRowClick(cid)}>
          <span className="col-colName-text" title={displayName}>
            {displayName}
          </span>
        </td>
        <td className="col-colType">{colTypeName}</td>
        <td className="col-check">
          <input
            className="colSel-check"
            type="checkbox"
            title="Show this column"
            onChange={() => actions.toggleShown(cid, stateRef)}
            checked={isShown}
          />
        </td>
        <td className="col-check">
          <input
            className="colSel-check"
            type="checkbox"
            title="Pivot by column"
            onChange={() => actions.togglePivot(cid, stateRef)}
            checked={isPivot}
          />
        </td>
        <td className="col-check">
          <input
            className="colSel-check"
            type="checkbox"
            title="Sort by column"
            onChange={() => actions.toggleSort(cid, stateRef)}
            checked={isSort}
          />
        </td>
      </tr>
    );
  };

  /**
   * row with checkboxes to select / deselect all listed items; while a
   * search filter is active this only governs the matching columns
   */
  const renderAllRow = (targetColumns: string[]) => {
    const shown = new Set(viewParams.displayColumns);
    const allShown =
      targetColumns.length > 0 &&
      targetColumns.every((cid) => shown.has(cid));
    const someShown = targetColumns.some((cid) => shown.has(cid));
    const filtered = targetColumns.length !== schema.columns.length;
    return (
      <tr className="all-row">
        <td className="col-colName-all">
          {filtered ? "All Matching" : "All Columns"}
        </td>
        <td className="col-colType" />
        <td className="col-check">
          <IndeterminateCheckbox
            className="colSel-check"
            type="checkbox"
            data-testid="column-select-all-check"
            title={
              filtered ? "Show all matching columns" : "Show all columns"
            }
            onChange={() => actions.toggleAllShown(targetColumns, stateRef)}
            checked={allShown}
            indeterminate={!allShown && someShown}
          />
        </td>
        <td className="col-check" />
        <td className="col-check" />
      </tr>
    );
  };

  const normalizedSearch = searchText.trim().toLocaleLowerCase();
  const columnIds = schema.columns.filter((cid) => {
    if (normalizedSearch.length === 0) {
      return true;
    }
    return (
      cid.toLocaleLowerCase().includes(normalizedSearch) ||
      schema
        .displayName(cid)
        .toLocaleLowerCase()
        .includes(normalizedSearch) ||
      schema
        .columnType(cid)
        .sqlTypeName.toLocaleLowerCase()
        .includes(normalizedSearch)
    );
  });
  columnIds.sort((cid1, cid2) =>
    schema.displayName(cid1).localeCompare(schema.displayName(cid2))
  );
  const allRow = renderAllRow(columnIds);
  const columnRows = columnIds.map((cid) => renderColumnRow(cid));
  const tableWidth = nameColWidth + TYPE_COL_WIDTH + 3 * CHECK_COL_WIDTH;
  const tableStyle = { width: tableWidth };
  const colGroup = (
    <colgroup>
      <col style={{ width: nameColWidth }} />
      <col style={{ width: TYPE_COL_WIDTH }} />
      <col style={{ width: CHECK_COL_WIDTH }} />
      <col style={{ width: CHECK_COL_WIDTH }} />
      <col style={{ width: CHECK_COL_WIDTH }} />
    </colgroup>
  );
  return (
    <div className="column-selector">
      <div className="column-selector-search">
        <input
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Search columns"
          aria-label="Search columns"
          data-testid="column-search-input"
        />
      </div>
      <div className="column-selector-scroll">
        <div className="column-selector-header">
          <table
            className="table table-condensed bp4-interactive column-selector-table"
            style={tableStyle}
          >
            {colGroup}
            <thead>
              <tr>
                <th className="column-selector-th col-colName">
                  Column
                  <div
                    className="col-resize-handle"
                    title="Drag to resize the column-name column"
                    data-testid="column-name-resize-handle"
                    onMouseDown={startNameColResize}
                  />
                </th>
                <th className="column-selector-th col-colType" />
                <th className="column-selector-th col-check">Show</th>
                <th className="column-selector-th col-check">Pivot</th>
                <th className="column-selector-th col-check">Sort</th>
              </tr>
            </thead>
            <tbody>{allRow}</tbody>
          </table>
        </div>
        <div className="column-selector-body">
          <table
            className="table table-condensed table-hover column-selector-table"
            style={tableStyle}
          >
            {colGroup}
            <tbody>{columnRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
