/**
 * Stata-style command bar: a single-line input with Enter-to-execute,
 * up/down command history, and a toggle for the results pane.
 */
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  caret: number
): CompletionSpan | null {
  const beforeCaret = input.slice(0, caret);
  const lastBacktick = beforeCaret.lastIndexOf("`");
  if (lastBacktick >= 0) {
    const backticksBefore = beforeCaret
      .slice(0, lastBacktick)
      .split("`").length - 1;
    if (backticksBefore % 2 === 0) {
      const closingBacktick = input.indexOf("`", caret);
      const end = closingBacktick >= 0 ? closingBacktick + 1 : input.length;
      return {
        start: lastBacktick,
        end,
        prefix: input.slice(lastBacktick + 1, caret),
      };
    }
  }

  let start = caret;
  while (start > 0 && /[A-Za-z0-9_*?]/.test(input[start - 1])) {
    start--;
  }
  if (start === caret) {
    return null;
  }
  let end = caret;
  while (end < input.length && /[A-Za-z0-9_*?]/.test(input[end])) {
    end++;
  }
  return {
    start,
    end,
    prefix: input.slice(start, caret),
  };
}

function longestCommonPrefix(names: string[]): string {
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (!name.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

/**
 * An open variable-completion menu: the input text surrounding the
 * token being completed, the candidate variables, and the highlighted
 * candidate. The menu is opened by Tab when several variables match;
 * up/down move the highlight, Tab/Enter accept it, Escape dismisses.
 */
interface CompletionMenu {
  before: string;
  after: string;
  matches: string[];
  index: number;
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
  const [completionMenu, setCompletionMenu] =
    useState<CompletionMenu | null>(null);
  const selectedItemRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // optional call: scrollIntoView is absent under jsdom
    selectedItemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [completionMenu]);

  const { commandRunning, commandResults } = appState;
  const history = useMemo(
    () => commandResults.toArray().map((e) => e.command),
    [commandResults]
  );
  const { baseSchema } = appState.viewState;
  const { sessionColumns, showRecordCount } = appState;
  const completionColumns = useMemo(
    () => commandActions.commandSchema(appState).columns,
    [baseSchema, sessionColumns, showRecordCount]
  );

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
    setCompletionMenu(null);
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
    setCompletionMenu(null);
  };

  const recallLastCommand = () => {
    if (history.length === 0) {
      return;
    }
    draftRef.current = inputValue;
    const nextIndex = history.length - 1;
    setHistIndex(nextIndex);
    setInputValue(history[nextIndex]);
    setCompletionMenu(null);
  };

  const acceptCompletion = (menu: CompletionMenu, index: number) => {
    const rendered = formatVariableForCommand(menu.matches[index]);
    setInputWithCaret(
      menu.before + rendered + menu.after,
      menu.before.length + rendered.length
    );
    setCompletionMenu(null);
  };

  const moveCompletionSelection = (menu: CompletionMenu, delta: -1 | 1) => {
    const count = menu.matches.length;
    setCompletionMenu({
      ...menu,
      index: (menu.index + delta + count) % count,
    });
  };

  /**
   * Tab pressed with no menu open: a unique match completes in place;
   * several matches first extend the typed prefix to their longest
   * common prefix, then open the dropdown menu to pick from.
   */
  const completeVariable = (caret: number): boolean => {
    const span = completionSpan(inputValue, caret);
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
    const before = inputValue.slice(0, span.start);
    const after = inputValue.slice(span.end);
    if (matches.length === 1) {
      const rendered = formatVariableForCommand(matches[0]);
      setInputWithCaret(
        before + rendered + after,
        before.length + rendered.length
      );
      return true;
    }
    const quoted = inputValue[span.start] === "`";
    let shared = longestCommonPrefix(matches);
    if (!quoted) {
      // outside backticks only bare-identifier characters survive
      // re-parsing on the next Tab, so stop the extension there
      shared = shared.match(/^[A-Za-z0-9_]*/)![0];
    }
    if (shared.length > span.prefix.length) {
      const extended = quoted ? "`" + shared : shared;
      setInputWithCaret(before + extended + after, before.length + extended.length);
    }
    setCompletionMenu({ before, after, matches, index: 0 });
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (completionMenu !== null) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        moveCompletionSelection(completionMenu, e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptCompletion(completionMenu, completionMenu.index);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCompletionMenu(null);
        return;
      }
      // any other key: fall through with the menu dismissed
      setCompletionMenu(null);
    }
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
      if (completeVariable(target.selectionStart ?? inputValue.length)) {
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

  const completionMenuElem =
    completionMenu === null ? null : (
      <ul
        className="command-completion-menu"
        data-testid="command-completion-menu"
        role="listbox"
      >
        {completionMenu.matches.map((column, i) => (
          <li
            key={column}
            ref={i === completionMenu.index ? selectedItemRef : null}
            className={
              i === completionMenu.index
                ? "command-completion-item selected"
                : "command-completion-item"
            }
            data-testid="command-completion-item"
            role="option"
            aria-selected={i === completionMenu.index}
            // mousedown rather than click so the input keeps focus
            onMouseDown={(e) => {
              e.preventDefault();
              acceptCompletion(completionMenu, i);
            }}
          >
            {column}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="command-bar-container">
      {errorIndicator}
      <div className="command-bar">
        <span className="command-prompt">.</span>
        {completionMenuElem}
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
            setCompletionMenu(null);
          }}
          onBlur={() => setCompletionMenu(null)}
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
