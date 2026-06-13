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

const SIMPLE_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUOTED_VARIABLE_KEYWORDS = new Set(["if", "null", "date"]);

export function formatVariableForCommand(name: string): string {
  if (
    SIMPLE_VARIABLE_RE.test(name) &&
    !QUOTED_VARIABLE_KEYWORDS.has(name)
  ) {
    return name;
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

interface CompletionSpan {
  start: number;
  end: number;
  prefix: string;
}

function completionSpan(
  input: string,
  selectionStart: number,
  selectionEnd: number
): CompletionSpan | null {
  if (selectionEnd > selectionStart) {
    return {
      start: selectionStart,
      end: selectionEnd,
      prefix: input.slice(selectionStart, selectionEnd).replace(/^`/, ""),
    };
  }

  const beforeCaret = input.slice(0, selectionStart);
  const lastBacktick = beforeCaret.lastIndexOf("`");
  if (lastBacktick >= 0) {
    const backticksBefore = beforeCaret
      .slice(0, lastBacktick)
      .split("`").length - 1;
    if (backticksBefore % 2 === 0) {
      let end = selectionEnd;
      if (input[end] === "`") end++;
      return {
        start: lastBacktick,
        end,
        prefix: input.slice(lastBacktick + 1, selectionStart),
      };
    }
  }

  let start = selectionStart;
  while (start > 0 && /[A-Za-z0-9_*?]/.test(input[start - 1])) {
    start--;
  }
  if (start === selectionStart) {
    return null;
  }
  return {
    start,
    end: selectionEnd,
    prefix: input.slice(start, selectionStart),
  };
}

interface CompletionCycle {
  before: string;
  after: string;
  matches: string[];
  index: number;
  rendered: string;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const completionRef = useRef<CompletionCycle | null>(null);

  const { commandRunning, commandResults } = appState;
  const history = commandResults.toArray().map((e) => e.command);
  const completionColumns = commandActions.commandSchema(appState).columns;

  const setInputWithCaret = (value: string, caret: number) => {
    setInputValue(value);
    setTimeout(() => inputRef.current?.setSelectionRange(caret, caret), 0);
  };

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
    completionRef.current = null;
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
    completionRef.current = null;
  };

  const recallLastCommand = () => {
    if (history.length === 0) {
      return;
    }
    draftRef.current = inputValue;
    const nextIndex = history.length - 1;
    setHistIndex(nextIndex);
    setInputValue(history[nextIndex]);
    completionRef.current = null;
  };

  const completeVariable = (
    selectionStart: number,
    selectionEnd: number
  ): boolean => {
    const previous = completionRef.current;
    if (
      previous !== null &&
      inputValue === previous.before + previous.rendered + previous.after &&
      selectionStart === previous.before.length + previous.rendered.length &&
      selectionEnd === selectionStart
    ) {
      const index = (previous.index + 1) % previous.matches.length;
      const rendered = formatVariableForCommand(previous.matches[index]);
      completionRef.current = { ...previous, index, rendered };
      const nextValue = previous.before + rendered + previous.after;
      setInputWithCaret(nextValue, previous.before.length + rendered.length);
      return true;
    }

    const span = completionSpan(inputValue, selectionStart, selectionEnd);
    if (span === null || span.prefix.length === 0) {
      return false;
    }
    if (inputValue.slice(0, span.start).trim().length === 0) {
      return false;
    }
    const matches = completionColumns.filter((column) =>
      column.startsWith(span.prefix)
    );
    if (matches.length === 0) {
      return false;
    }
    const rendered = formatVariableForCommand(matches[0]);
    const before = inputValue.slice(0, span.start);
    const after = inputValue.slice(span.end);
    completionRef.current = {
      before,
      after,
      matches,
      index: 0,
      rendered,
    };
    setInputWithCaret(before + rendered + after, before.length + rendered.length);
    return true;
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
    } else if (e.key === "PageUp") {
      e.preventDefault();
      recallLastCommand();
    } else if (e.key === "Tab") {
      const target = e.currentTarget;
      if (
        completeVariable(
          target.selectionStart ?? inputValue.length,
          target.selectionEnd ?? inputValue.length
        )
      ) {
        e.preventDefault();
      }
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
          ref={inputRef}
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
            completionRef.current = null;
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
          intent="danger"
          disabled={!commandRunning}
          onClick={() => {
            void commandActions.interruptCommand(stateRef).catch((err) => {
              console.error("Failed to interrupt command", err);
            });
          }}
          data-testid="command-break-button"
          title="Interrupt the running command"
        >
          Break
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
