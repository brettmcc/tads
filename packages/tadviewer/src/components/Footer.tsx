import * as React from "react";
import * as reltab from "reltab";
import * as actions from "../actions";
import { FilterEditor } from "./FilterEditor";
import { AppState } from "../AppState";
import { ViewState } from "../ViewState";
import { StateRef } from "oneref";
import { useEffect, useState } from "react";
import { getDefaultDialect } from "reltab";

export interface FooterProps {
  appState: AppState;
  stateRef: StateRef<AppState>;
  onFilter?: (filterExp: reltab.FilterExp) => void;
  rightFooterSlot?: JSX.Element;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: value < 10 ? 2 : value < 100 ? 1 : 0,
  })} ${units[unitIndex]}`;
}

export const Footer: React.FunctionComponent<FooterProps> = (
  props: FooterProps
) => {
  const { appState, stateRef, rightFooterSlot = undefined, onFilter } = props;
  const [expanded, setExpanded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [prevFilter, setPrevFilter] = useState<reltab.FilterExp | null>(null);
  const [datasetInfo, setDatasetInfo] =
    useState<reltab.DatasetInfo | null>(null);

  // console.log("Footer: ", appState.toJS());

  const viewState = appState.viewState;
  const dsPath = viewState.dsPath;

  useEffect(() => {
    let cancelled = false;
    if (dsPath == null) {
      setDatasetInfo(null);
      return () => {
        cancelled = true;
      };
    }
    const refresh = () => {
      viewState.dbc
        .getDatasetInfo(dsPath)
        .then((info) => {
          if (!cancelled) setDatasetInfo(info);
        })
        .catch(() => {
          if (!cancelled) setDatasetInfo(null);
        });
    };
    refresh();
    // memory usage grows as queries run (grid paging, Stata commands); poll
    // so the footer doesn't freeze at the value captured on dataset load.
    const intervalId = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [viewState.dbc, dsPath]);

  const setExpandedState = (nextState: boolean) => {
    if (nextState && !dirty) {
      // snap current filter into prevFilter:
      setExpanded(nextState);
      setPrevFilter(viewState.viewParams.filterExp);
      setDirty(true);
    } else {
      setExpanded(nextState);
    }
  };

  const handleFilterButtonClicked = (event: any) => {
    event.preventDefault();
    const nextState = !expanded;
    setExpandedState(nextState);
  };

  const handleFilterCancel = () => {
    // restore previous filter:
    const fe = prevFilter || new reltab.FilterExp();
    actions.setFilter(fe, stateRef);
    setExpandedState(false);
    setDirty(false);
    setPrevFilter(null);
  };

  const handleFilterApply = (filterExp: reltab.FilterExp) => {
    actions.setFilter(filterExp, stateRef);
    onFilter?.(filterExp);
  };

  const handleFilterDone = () => {
    setExpandedState(false);
    setDirty(false);
    setPrevFilter(null);
  };

  const filterExp = appState.viewState.viewParams.filterExp;
  const filterStr = filterExp.toSqlWhere(getDefaultDialect());

  const expandClass = expanded ? "footer-expanded" : "footer-collapsed";

  const editorComponent = expanded ? (
    <FilterEditor
      appState={appState}
      stateRef={stateRef}
      schema={viewState.baseSchema}
      filterExp={filterExp}
      onCancel={handleFilterCancel}
      onApply={handleFilterApply}
      onDone={handleFilterDone}
    />
  ) : null;

  let rowCountBlock = null;
  const queryView = appState.viewState.queryView;
  if (queryView) {
    const numFmt = (num: number) =>
      num.toLocaleString(undefined, { useGrouping: true });

    const { rowCount, baseRowCount, filterRowCount } = queryView;
    const rowCountStr = numFmt(rowCount);
    const rcParts = [rowCountStr];
    if (rowCount !== baseRowCount) {
      rcParts.push(" (");
      if (filterRowCount !== baseRowCount && filterRowCount !== rowCount) {
        const filterCountStr = numFmt(filterRowCount);
        rcParts.push(filterCountStr);
        rcParts.push(" Filtered, ");
      }
      rcParts.push(numFmt(baseRowCount));
      rcParts.push(" Total)");
    }
    const rcStr = rcParts.join("");
    rowCountBlock = (
      <div className="footer-block">
        <span className="footer-value">
          {rcStr} Row{rowCount === 1 ? "" : "s"}
        </span>
      </div>
    );
  }
  const sizeParts: string[] = [];
  if (datasetInfo?.sourceSizeBytes != null) {
    sizeParts.push(`Disk ${formatByteSize(datasetInfo.sourceSizeBytes)}`);
  }
  if (datasetInfo?.memorySizeBytes != null) {
    sizeParts.push(`Memory ${formatByteSize(datasetInfo.memorySizeBytes)}`);
  }
  const datasetSizeBlock =
    sizeParts.length === 0 ? null : (
      <div
        className="footer-block footer-dataset-size"
        data-testid="footer-dataset-size"
        title="Dataset source size and current DuckDB buffer-manager memory"
      >
        <span className="footer-value">{sizeParts.join(" · ")}</span>
      </div>
    );
  return (
    <div className={"footer " + expandClass}>
      <div className="footer-top-row">
        <div className="footer-filter-block">
          <a onClick={(event) => handleFilterButtonClicked(event)} tabIndex={0}>
            Filter
          </a>
          <span className="filter-summary"> {filterStr}</span>
        </div>
        <div className="footer-right-block">
          {datasetSizeBlock}
          {rowCountBlock}
          {rightFooterSlot}
        </div>
      </div>
      {editorComponent}
    </div>
  );
};
