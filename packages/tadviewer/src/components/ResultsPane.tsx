/**
 * Append-only results pane for Stata-style commands. Each entry echoes
 * the command, renders its output blocks as semantic tables (or
 * codebook sections), and exposes the generated SQL behind a
 * collapsible disclosure.
 */
import * as React from "react";
import { useEffect, useRef } from "react";
import { Button } from "@blueprintjs/core";
import { StateRef } from "oneref";
import { AppState } from "../AppState";
import * as commandActions from "../commandActions";
import { CommandResultEntry } from "../commandState";
import { CellValue, ResultBlock } from "../stataCommand";

export interface ResultsPaneProps {
  appState: AppState;
  stateRef: StateRef<AppState>;
}

/**
 * Format a cell for display: integers with grouping, fractional numbers
 * with up to 6 significant fractional digits, nulls as blank.
 */
export function formatCell(v: CellValue): string {
  if (v == null) {
    return "";
  }
  if (typeof v === "number") {
    if (Number.isInteger(v)) {
      return v.toLocaleString("en-US", { useGrouping: true });
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
          <details className="entry-sql" data-testid="entry-sql">
            <summary>SQL</summary>
            <pre>{entry.sql}</pre>
          </details>
        </>
      )}
    </div>
  );
};

export const ResultsPane: React.FunctionComponent<ResultsPaneProps> = ({
  appState,
  stateRef,
}: ResultsPaneProps) => {
  const entries = appState.commandResults.toArray();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // keep the newest entry visible as results append
  useEffect(() => {
    const el = scrollRef.current;
    if (el != null) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length]);

  if (!appState.resultsPaneOpen) {
    return null;
  }

  return (
    <div className="command-results-pane" data-testid="results-pane">
      <div className="results-pane-header">
        <span className="results-pane-title">Results</span>
        <div className="results-pane-actions">
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
