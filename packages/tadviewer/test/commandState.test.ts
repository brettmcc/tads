/**
 * State tests for the command results log: append-only behavior,
 * deterministic ids, auto-open rules, pane toggling, and clear-history.
 */
import * as Immutable from "immutable";
import { mkRef, mutableGet } from "oneref";
import { AppState } from "../src/AppState";
import {
  entryAutoOpensPane,
  mkResultEntry,
  nextEntryId,
  resetEntryIds,
} from "../src/commandState";
import {
  clearCommandResults,
  setResultsPaneOpen,
  toggleResultsPane,
} from "../src/commandActions";
import { CommandOutcome } from "../src/stataCommand";

beforeEach(() => {
  resetEntryIds();
});

const okOutcome = (kind: "browse" | "summarize"): CommandOutcome => ({
  status: "ok",
  kind,
  command: kind === "browse" ? "bro a" : "sum a",
  sql: "SELECT 1",
  blocks: [{ kind: "text", text: "x" }],
});

const errOutcome: CommandOutcome = {
  status: "error",
  command: "sum nope",
  error: "unknown variable 'nope'",
};

describe("entry construction", () => {
  test("ids are deterministic and increasing", () => {
    expect(nextEntryId()).toBe("cmd-1");
    expect(nextEntryId()).toBe("cmd-2");
    resetEntryIds();
    expect(nextEntryId()).toBe("cmd-1");
  });

  test("ok outcome entry", () => {
    const entry = mkResultEntry(okOutcome("summarize"), "2026-06-12T00:00:00.000Z", 12);
    expect(entry).toEqual({
      id: "cmd-1",
      command: "sum a",
      kind: "summarize",
      startedAt: "2026-06-12T00:00:00.000Z",
      elapsedMs: 12,
      sql: "SELECT 1",
      status: "ok",
      output: [{ kind: "text", text: "x" }],
    });
  });

  test("error outcome entry", () => {
    const entry = mkResultEntry(errOutcome, "2026-06-12T00:00:00.000Z", 3);
    expect(entry.status).toBe("error");
    expect(entry.error).toBe("unknown variable 'nope'");
    expect(entry.sql).toBe("");
    expect(entry.kind).toBeUndefined();
  });

  test("auto-open: summarize and errors open, browse does not", () => {
    const sumEntry = mkResultEntry(okOutcome("summarize"), "t", 1);
    const broEntry = mkResultEntry(okOutcome("browse"), "t", 1);
    const errEntry = mkResultEntry(errOutcome, "t", 1);
    expect(entryAutoOpensPane(sumEntry)).toBe(true);
    expect(entryAutoOpensPane(broEntry)).toBe(false);
    expect(entryAutoOpensPane(errEntry)).toBe(true);
  });
});

describe("pane state actions", () => {
  test("toggle and explicit set", () => {
    const stateRef = mkRef(new AppState());
    expect(mutableGet(stateRef).resultsPaneOpen).toBe(false);
    toggleResultsPane(stateRef);
    expect(mutableGet(stateRef).resultsPaneOpen).toBe(true);
    toggleResultsPane(stateRef);
    expect(mutableGet(stateRef).resultsPaneOpen).toBe(false);
    setResultsPaneOpen(true, stateRef);
    expect(mutableGet(stateRef).resultsPaneOpen).toBe(true);
  });

  test("clear-history empties results but does not hide the pane", () => {
    const e1 = mkResultEntry(okOutcome("summarize"), "t", 1);
    const e2 = mkResultEntry(errOutcome, "t", 1);
    const initial = new AppState()
      .set("commandResults", Immutable.List([e1, e2]))
      .set("resultsPaneOpen", true) as AppState;
    const stateRef = mkRef(initial);

    clearCommandResults(stateRef);
    const st = mutableGet(stateRef);
    expect(st.commandResults.size).toBe(0);
    expect(st.resultsPaneOpen).toBe(true);
  });

  test("results list is append-only ordered", () => {
    const e1 = mkResultEntry(okOutcome("summarize"), "t", 1);
    const e2 = mkResultEntry(okOutcome("browse"), "t", 1);
    const e3 = mkResultEntry(errOutcome, "t", 1);
    let st = new AppState();
    st = st.set("commandResults", st.commandResults.push(e1)) as AppState;
    st = st.set("commandResults", st.commandResults.push(e2)) as AppState;
    st = st.set("commandResults", st.commandResults.push(e3)) as AppState;
    expect(st.commandResults.toArray().map((e) => e.id)).toEqual([
      "cmd-1",
      "cmd-2",
      "cmd-3",
    ]);
  });
});
