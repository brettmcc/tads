/**
 * Append-only results pane for Stata-style commands. Each entry echoes
 * the command, renders its output blocks as semantic tables (or
 * codebook sections), and exposes the generated SQL behind a
 * collapsible disclosure. Only results run against the dataset being
 * viewed are shown; each dataset keeps its own log.
 */
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@blueprintjs/core";
import { StateRef } from "oneref";
import {
  VictoryAxis,
  VictoryBar,
  VictoryChart,
  VictoryTheme,
} from "victory";
import { AppState } from "../AppState";
import * as commandActions from "../commandActions";
import { CommandResultEntry } from "../commandState";
import { CellValue, ResultBlock } from "../stataCommand";

export interface ResultsPaneProps {
  appState: AppState;
  stateRef: StateRef<AppState>;
}

/**
 * Format a cell for display: integers with grouping from five digits up
 * (no comma in years like 2024), fractional numbers with up to 7
 * significant digits, nulls as blank.
 */
export function formatCell(v: CellValue): string {
  if (v == null) {
    return "";
  }
  if (typeof v === "number") {
    if (Number.isInteger(v)) {
      return Math.abs(v) >= 10000
        ? v.toLocaleString("en-US", { useGrouping: true })
        : String(v);
    }
    return String(Number(v.toPrecision(7)));
  }
  return String(v);
}

const BlockTable: React.FunctionComponent<{
  block: ResultBlock & { kind: "table" };
}> = ({ block }) => (
  <table className="command-result-table">
    <thead>
      <tr>
        {block.columns.map((c, i) => (
          <th key={i} className={`cell-${block.align[i] ?? "left"}`}>
            {c}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {block.rows.map((row, ri) => (
        <tr key={ri}>
          {row.map((cell, ci) => (
            <td key={ci} className={`cell-${block.align[ci] ?? "left"}`}>
              {formatCell(cell)}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

const CodebookVarBlock: React.FunctionComponent<{
  block: ResultBlock & { kind: "codebookVar" };
}> = ({ block }) => {
  const topValues =
    block.topValues === undefined ? null : (
      <table className="command-result-table">
        <thead>
          <tr>
            <th className="cell-left">Value</th>
            <th className="cell-right">Freq.</th>
          </tr>
        </thead>
        <tbody>
          {block.topValues.map((tv, i) => (
            <tr key={i}>
              <td className="cell-left">{tv.value}</td>
              <td className="cell-right">{formatCell(tv.freq)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  return (
    <div className="codebook-var">
      <div className="codebook-var-header">
        <span className="codebook-var-name">{block.variable}</span>
        <span className="codebook-var-type">{block.sqlType}</span>
      </div>
      <table className="command-result-table">
        <tbody>
          <tr>
            <td className="cell-left">N</td>
            <td className="cell-right">{formatCell(block.n)}</td>
          </tr>
          <tr>
            <td className="cell-left">Missing</td>
            <td className="cell-right">{formatCell(block.missing)}</td>
          </tr>
          <tr>
            <td className="cell-left">Distinct</td>
            <td className="cell-right">{formatCell(block.distinct)}</td>
          </tr>
          {block.min !== undefined ? (
            <tr>
              <td className="cell-left">Min</td>
              <td className="cell-right">{block.min ?? ""}</td>
            </tr>
          ) : null}
          {block.max !== undefined ? (
            <tr>
              <td className="cell-left">Max</td>
              <td className="cell-right">{block.max ?? ""}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {topValues}
    </div>
  );
};

const SumDetailBlock: React.FunctionComponent<{
  block: ResultBlock & { kind: "sumDetail" };
}> = ({ block }) => {
  const fmt = (v: number | null) => formatCell(v);
  const stats: Array<[string, number | null]> = [
    ["Obs", block.n],
    ["Sum", block.sum],
    ["Mean", block.mean],
    ["Std. dev.", block.sd],
    ["Variance", block.variance],
    ["Skewness", block.skewness],
    ["Kurtosis", block.kurtosis],
  ];
  return (
    <div className="sum-detail" data-testid="sum-detail">
      <div className="codebook-var-header">
        <span className="codebook-var-name">{block.variable}</span>
      </div>
      <div className="sum-detail-grid">
        <table className="command-result-table">
          <thead>
            <tr>
              <th className="cell-left">Pctl.</th>
              <th className="cell-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {block.percentiles.map((pe) => (
              <tr key={pe.p}>
                <td className="cell-left">{pe.p}%</td>
                <td className="cell-right">{fmt(pe.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="command-result-table">
          <thead>
            <tr>
              <th className="cell-right">Smallest</th>
              <th className="cell-right">Largest</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3].map((i) => (
              <tr key={i}>
                <td className="cell-right">
                  {block.smallest[i] !== undefined
                    ? fmt(block.smallest[i])
                    : ""}
                </td>
                <td className="cell-right">
                  {block.largest[i] !== undefined ? fmt(block.largest[i]) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="command-result-table">
          <tbody>
            {stats.map(([label, v]) => (
              <tr key={label}>
                <td className="cell-left">{label}</td>
                <td className="cell-right">{fmt(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const HistogramBlock: React.FunctionComponent<{
  block: ResultBlock & { kind: "histogram" };
}> = ({ block }) => {
  const data = block.freqs.map((freq, i) => ({
    x: block.binStart + (i + 0.5) * block.binWidth,
    y: freq,
  }));
  // Graphite theme: Victory's material theme assumes a light canvas;
  // recolor axes/labels for the dark results pane.
  const axisStyle = {
    axis: { stroke: "#343842" },
    ticks: { stroke: "#343842" },
    tickLabels: { fill: "#aeb5c2" },
    grid: { stroke: "transparent" },
  };
  return (
    <div className="command-histogram" data-testid="histogram-block">
      <VictoryChart
        theme={VictoryTheme.material}
        domainPadding={{ x: 8 }}
        width={420}
        height={220}
        padding={{ top: 8, bottom: 32, left: 56, right: 16 }}
      >
        <VictoryAxis
          label={block.variable}
          style={{
            ...axisStyle,
            axisLabel: { padding: 22, fill: "#aeb5c2" },
          }}
        />
        <VictoryAxis dependentAxis style={axisStyle} />
        <VictoryBar
          data={data}
          barWidth={Math.max(
            2,
            Math.floor(340 / Math.max(1, block.freqs.length)) - 2
          )}
          style={{ data: { fill: "#6ca4f8" } }}
        />
      </VictoryChart>
      <div className="command-result-text">
        {block.freqs.length} bin{block.freqs.length === 1 ? "" : "s"}, N ={" "}
        {block.n.toLocaleString("en-US")}
      </div>
    </div>
  );
};

const ResultBlockView: React.FunctionComponent<{ block: ResultBlock }> = ({
  block,
}) => {
  switch (block.kind) {
    case "table":
      return <BlockTable block={block} />;
    case "text":
      return <div className="command-result-text">{block.text}</div>;
    case "codebookVar":
      return <CodebookVarBlock block={block} />;
    case "sumDetail":
      return <SumDetailBlock block={block} />;
    case "histogram":
      return <HistogramBlock block={block} />;
  }
};

const ResultEntryView: React.FunctionComponent<{
  entry: CommandResultEntry;
}> = ({ entry }) => {
  const statusClass =
    entry.status === "ok" ? "entry-status-ok" : "entry-status-error";
  return (
    <div className={`command-result-entry ${statusClass}`} data-testid="result-entry">
      <div className="entry-command-line">
        <span className="entry-prompt">.</span>
        <span className="entry-command">{entry.command}</span>
        <span className="entry-elapsed">{entry.elapsedMs} ms</span>
      </div>
      {entry.status === "error" ? (
        <pre className="entry-error" data-testid="entry-error">
          {entry.error}
        </pre>
      ) : (
        <>
          {(entry.output ?? []).map((block, i) => (
            <ResultBlockView key={i} block={block} />
          ))}
          {entry.sql !== "" ? (
            <details className="entry-sql" data-testid="entry-sql">
              <summary>SQL</summary>
              <pre>{entry.sql}</pre>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
};

// smallest useful results pane, and the space we always leave for the grid
const MIN_RESULTS_HEIGHT = 120;
const MIN_GRID_HEIGHT = 160;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Ctrl+F support: we highlight matches with the CSS Custom Highlight API
 * rather than wrapping text in <mark> elements, so React's DOM stays
 * untouched. Chromium has it since 105; jsdom (tests) does not, so every
 * use is feature-guarded and find still navigates without it.
 */
const HIGHLIGHT_ALL = "tad-find";
const HIGHLIGHT_ACTIVE = "tad-find-active";

const highlightRegistry = (): any => {
  const cssObj: any = typeof CSS === "undefined" ? null : CSS;
  return cssObj?.highlights ?? null;
};

const clearHighlights = () => {
  const registry = highlightRegistry();
  if (registry != null) {
    registry.delete(HIGHLIGHT_ALL);
    registry.delete(HIGHLIGHT_ACTIVE);
  }
};

const setHighlights = (matches: Range[], activeIndex: number) => {
  const registry = highlightRegistry();
  const HighlightCtor: any = (window as any).Highlight;
  if (registry == null || HighlightCtor == null) {
    return;
  }
  const others = matches.filter((_, i) => i !== activeIndex);
  registry.set(HIGHLIGHT_ALL, new HighlightCtor(...others));
  const active = matches[activeIndex];
  if (active !== undefined) {
    registry.set(HIGHLIGHT_ACTIVE, new HighlightCtor(active));
  } else {
    registry.delete(HIGHLIGHT_ACTIVE);
  }
};

/** All ranges in `root` matching `query`, case-insensitively, in document order. */
export function collectMatches(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  if (needle === "") {
    return [];
  }
  const matches: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node != null) {
    const parent = node.parentElement;
    // text inside a collapsed <details> (the SQL disclosure) isn't visible
    if (parent != null && parent.closest("details:not([open])") == null) {
      const hay = (node.nodeValue ?? "").toLowerCase();
      let from = hay.indexOf(needle);
      while (from !== -1) {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + needle.length);
        matches.push(range);
        from = hay.indexOf(needle, from + needle.length);
      }
    }
    node = walker.nextNode();
  }
  return matches;
}

export const ResultsPane: React.FunctionComponent<ResultsPaneProps> = ({
  appState,
  stateRef,
}: ResultsPaneProps) => {
  const dsKey = commandActions.currentDatasetKey(appState);
  const entries = useMemo(
    () => commandActions.currentDatasetResults(appState),
    [appState.commandResults, dsKey]
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  // null == use the CSS default height; a number means the user has dragged
  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  // find-in-results state; the ranges themselves live in a ref since they're
  // DOM objects, not renderable state
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const matchesRef = useRef<Range[]>([]);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  // a dragged height can outgrow the window; re-clamp when it shrinks
  const userSized = height != null;
  useEffect(() => {
    if (!userSized) {
      return;
    }
    const onWindowResize = () => {
      const parent = paneRef.current?.parentElement;
      if (parent == null) {
        return;
      }
      setHeight((h) =>
        h == null
          ? h
          : clamp(h, MIN_RESULTS_HEIGHT, parent.clientHeight - MIN_GRID_HEIGHT)
      );
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [userSized]);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pane = paneRef.current;
      if (pane == null || e.button !== 0) {
        return;
      }
      e.preventDefault();
      // jsdom (tests) has no pointer capture API
      e.currentTarget.setPointerCapture?.(e.pointerId);
      dragStart.current = {
        y: e.clientY,
        h: pane.getBoundingClientRect().height,
      };
      setDragging(true);
    },
    []
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current;
      const pane = paneRef.current;
      if (start == null || pane == null) {
        return;
      }
      const parent = pane.parentElement;
      const maxHeight =
        parent != null
          ? parent.clientHeight - MIN_GRID_HEIGHT
          : window.innerHeight - MIN_GRID_HEIGHT;
      // dragging up (smaller clientY) grows the pane
      setHeight(
        clamp(start.h + (start.y - e.clientY), MIN_RESULTS_HEIGHT, maxHeight)
      );
    },
    []
  );

  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current == null) {
      return;
    }
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragStart.current = null;
    setDragging(false);
  }, []);

  // keep the newest entry visible as results append
  useEffect(() => {
    const el = scrollRef.current;
    if (el != null) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const resultsPaneOpen = appState.resultsPaneOpen;

  // Ctrl+F (Cmd+F on mac) opens the find bar, opening the pane if needed
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (!resultsPaneOpen) {
          commandActions.setResultsPaneOpen(true, stateRef);
        }
        setFindOpen(true);
        findInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [resultsPaneOpen, stateRef]);

  // focus the find input when the bar first appears
  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [findOpen]);

  // a new search term always starts from the first match
  useEffect(() => {
    setActiveMatch(0);
  }, [findQuery]);

  // (re)scan the rendered results whenever the term or the results change
  useEffect(() => {
    const el = scrollRef.current;
    const matches =
      findOpen && el != null ? collectMatches(el, findQuery) : [];
    matchesRef.current = matches;
    setMatchCount(matches.length);
    setActiveMatch((a) => (matches.length === 0 ? 0 : Math.min(a, matches.length - 1)));
  }, [findOpen, findQuery, entries, resultsPaneOpen]);

  // paint the highlights and keep the current match on screen
  useEffect(() => {
    const matches = matchesRef.current;
    setHighlights(matches, activeMatch);
    const el = scrollRef.current;
    const range = matches[activeMatch];
    if (el == null || range == null || range.getBoundingClientRect == null) {
      return;
    }
    const rect = range.getBoundingClientRect();
    const viewRect = el.getBoundingClientRect();
    if (rect.top < viewRect.top) {
      el.scrollTop -= viewRect.top - rect.top + 24;
    } else if (rect.bottom > viewRect.bottom) {
      el.scrollTop += rect.bottom - viewRect.bottom + 24;
    }
  }, [matchCount, activeMatch, findQuery]);

  // never leave stale highlights behind
  useEffect(() => clearHighlights, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    matchesRef.current = [];
    setMatchCount(0);
    clearHighlights();
  }, []);

  const stepMatch = useCallback(
    (delta: number) => {
      setActiveMatch((a) => {
        const n = matchesRef.current.length;
        return n === 0 ? 0 : (a + delta + n) % n;
      });
    },
    []
  );

  const onFindKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stepMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeFind();
      }
    },
    [stepMatch, closeFind]
  );

  if (!appState.resultsPaneOpen) {
    return null;
  }

  return (
    <div
      className="command-results-pane"
      data-testid="results-pane"
      ref={paneRef}
      style={height == null ? undefined : { height, maxHeight: "none" }}
    >
      <div
        className={
          "results-pane-resizer" + (dragging ? " results-pane-resizer-active" : "")
        }
        data-testid="results-pane-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize results pane"
        title="Drag to resize (double-click to reset)"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={() => setHeight(null)}
      >
        <span className="results-pane-resizer-grip" />
      </div>
      <div className="results-pane-header">
        <span className="results-pane-title">Results</span>
        <div className="results-pane-actions">
          <Button
            small={true}
            minimal={true}
            icon="search"
            title="Find in results (Ctrl+F)"
            active={findOpen}
            onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
            data-testid="results-find-button"
          />
          <Button
            small={true}
            minimal={true}
            disabled={entries.length === 0}
            onClick={() => commandActions.clearCommandResults(stateRef)}
            data-testid="results-clear-button"
          >
            Clear
          </Button>
          <Button
            small={true}
            minimal={true}
            icon="cross"
            title="Hide results pane"
            onClick={() => commandActions.setResultsPaneOpen(false, stateRef)}
            data-testid="results-close-button"
          />
        </div>
      </div>
      {findOpen ? (
        <div className="results-find-bar" data-testid="results-find-bar">
          <input
            className="results-find-input"
            type="text"
            placeholder="Find in results"
            spellCheck={false}
            value={findQuery}
            ref={findInputRef}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={onFindKeyDown}
            data-testid="results-find-input"
          />
          <span
            className={
              "results-find-count" +
              (findQuery !== "" && matchCount === 0
                ? " results-find-count-empty"
                : "")
            }
            data-testid="results-find-count"
          >
            {findQuery === ""
              ? ""
              : matchCount === 0
              ? "No results"
              : `${activeMatch + 1} of ${matchCount}`}
          </span>
          <Button
            small={true}
            minimal={true}
            icon="chevron-up"
            title="Previous match (Shift+Enter)"
            disabled={matchCount === 0}
            onClick={() => stepMatch(-1)}
            data-testid="results-find-prev"
          />
          <Button
            small={true}
            minimal={true}
            icon="chevron-down"
            title="Next match (Enter)"
            disabled={matchCount === 0}
            onClick={() => stepMatch(1)}
            data-testid="results-find-next"
          />
          <Button
            small={true}
            minimal={true}
            icon="cross"
            title="Close find (Esc)"
            onClick={closeFind}
            data-testid="results-find-close"
          />
        </div>
      ) : null}
      <div className="results-pane-scroll" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="results-pane-empty">
            No results yet. Run a command below, e.g.{" "}
            <code>sum mycol if other &gt; 0</code>.
          </div>
        ) : (
          entries.map((entry) => (
            <ResultEntryView key={entry.id} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
};
