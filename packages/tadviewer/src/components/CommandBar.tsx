/**
 * Stata-style command bar: a single-line input with Enter-to-execute,
 * up/down command history, and a toggle for the results pane.
 */
import * as React from "react";
import { useRef, useState } from "react";
import { Button } from "@blueprintjs/core";
import { StateRef } from "oneref";
import { AppState } from "../AppState";
import * as commandActions from "../commandActions";

export interface CommandBarProps {
  appState: AppState;
  stateRef: StateRef<AppState>;
}

export const CommandBar: React.FunctionComponent<CommandBarProps> = ({
  appState,
  stateRef,
}: CommandBarProps) => {
  const [inputValue, setInputValue] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  // index into the command history while navigating with up/down;
  // null means "not navigating" (draft preserved separately)
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const draftRef = useRef("");

  const { commandRunning, commandResults } = appState;
  const history = commandResults.toArray().map((e) => e.command);

  const runCommand = async () => {
    if (commandRunning || inputValue.trim().length === 0) {
      return;
    }
    setLastError(null);
    const entry = await commandActions.runCommandLine(inputValue, stateRef);
    if (entry == null) {
      return;
    }
    if (entry.status === "error") {
      // preserve the typed command for correction; surface the error
      setLastError(entry.error ?? "command failed");
    } else {
      setInputValue("");
    }
    setHistIndex(null);
  };

  const navigateHistory = (delta: -1 | 1) => {
    if (history.length === 0) {
      return;
    }
    let nextIndex: number | null;
    if (histIndex === null) {
      if (delta === 1) {
        return; // down with no navigation in progress: nothing to do
      }
      draftRef.current = inputValue;
      nextIndex = history.length - 1;
    } else {
      nextIndex = histIndex + delta;
      if (nextIndex >= history.length) {
        // navigated past the newest entry: restore draft
        setHistIndex(null);
        setInputValue(draftRef.current);
        return;
      }
      if (nextIndex < 0) {
        nextIndex = 0;
      }
    }
    setHistIndex(nextIndex);
    setInputValue(history[nextIndex]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateHistory(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateHistory(1);
    }
  };

  const errorIndicator =
    lastError === null ? null : (
      <div className="command-bar-error" data-testid="command-bar-error">
        {conciseError(lastError)}
      </div>
    );

  return (
    <div className="command-bar-container">
      {errorIndicator}
      <div className="command-bar">
        <span className="command-prompt">.</span>
        <input
          className="command-input"
          data-testid="command-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder='Stata-style command, e.g. sum price if mpg > 20 (browse, sum, tab, codebook)'
          value={inputValue}
          disabled={commandRunning}
          onChange={(e) => {
            setInputValue(e.target.value);
            setLastError(null);
            setHistIndex(null);
          }}
          onKeyDown={handleKeyDown}
        />
        <Button
          small={true}
          disabled={commandRunning || inputValue.trim().length === 0}
          onClick={runCommand}
          data-testid="command-run-button"
        >
          Run
        </Button>
        <Button
          small={true}
          active={appState.resultsPaneOpen}
          onClick={() => commandActions.toggleResultsPane(stateRef)}
          data-testid="results-toggle-button"
          title="Toggle results pane (Ctrl+`)"
        >
          Results
        </Button>
      </div>
    </div>
  );
};

/**
 * Errors formatted with a caret marker put the human-readable message on
 * the last line; single-line errors are already concise.
 */
function conciseError(s: string): string {
  const lines = s.split("\n");
  return lines[lines.length - 1];
}
