/**
 * @jest-environment jsdom
 *
 * Component tests for the command bar and results pane, driven through
 * the real oneref state container and command actions, with a stubbed
 * DataSourceConnection supplying canned SQL results.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import * as Immutable from "immutable";
import { mkRef, mutableGet, refContainer, StateRef, update } from "oneref";
import * as React from "react";
import {
  ColumnMetaMap,
  DataSourceConnection,
  DuckDBDialect,
  ReadOnlySqlResult,
  Row,
  Schema,
  tableQuery,
} from "reltab";
import { AppState } from "../src/AppState";
import { toggleShown } from "../src/actions";
import { commandSchema } from "../src/commandActions";
import { resetEntryIds } from "../src/commandState";
import {
  CellContentBar,
  formatCellValueText,
} from "../src/components/CellContentBar";
import {
  CommandBar,
  formatVariableForCommand,
} from "../src/components/CommandBar";
import { ColumnSelector } from "../src/components/ColumnSelector";
import { Footer, formatByteSize } from "../src/components/Footer";
import { ResultsPane } from "../src/components/ResultsPane";
import { formatCell } from "../src/components/ResultsPane";
import { ViewParams } from "../src/ViewParams";
import { ViewState } from "../src/ViewState";

type ColSpec = [string, string];

function mkSchema(
  cols: ColSpec[] = [
    ["a", "INTEGER"],
    ["b", "DOUBLE"],
    ["s", "VARCHAR"],
    ["has space", "INTEGER"],
  ]
): Schema {
  const cmMap: ColumnMetaMap = {};
  for (const [colId, columnType] of cols) {
    cmMap[colId] = { displayName: colId, columnType };
  }
  return new Schema(
    DuckDBDialect,
    cols.map(([c]) => c),
    cmMap
  );
}

const schema = mkSchema();

/** canned summarize result for `sum a` (single wide aggregate row) */
const sumRows: Row[] = [{ n_0: 3, mean_0: 2, sd_0: 1, min_0: 1, max_0: 3 }];
const interruptMock = jest.fn(async (): Promise<void> => {});
const getDatasetInfoMock = jest.fn(async (): Promise<any> => ({
  sourceSizeBytes: 1536,
  memorySizeBytes: 5 * 1024 * 1024,
}));
const setMaterializedMock = jest.fn(
  async (_path: any, _materialized: boolean): Promise<void> => {}
);
const getMaterializeEstimateMock = jest.fn(async (): Promise<any> => ({
  estimatedBytes: 1024,
  systemFreeMemBytes: 8 * 1024 ** 3,
  systemTotalMemBytes: 16 * 1024 ** 3,
}));

function mkFakeDbc(): DataSourceConnection {
  const fake: Partial<DataSourceConnection> = {
    runReadOnlySql: async (sql: string): Promise<ReadOnlySqlResult> => {
      if (sql.indexOf("stddev_samp") >= 0) {
        return { schema, rows: sumRows };
      }
      return { schema, rows: [] };
    },
    interrupt: interruptMock,
    getDatasetInfo: getDatasetInfoMock,
    setMaterialized: setMaterializedMock,
    getMaterializeEstimate: getMaterializeEstimateMock,
  };
  return fake as DataSourceConnection;
}

function mkAppState(sch: Schema = schema): AppState {
  const viewParams = new ViewParams({
    displayColumns: sch.columns.slice(),
  });
  const viewState = new ViewState({
    dbc: mkFakeDbc(),
    dsPath: {
      sourceId: { providerName: "duckdb", resourceId: ":memory:" },
      path: ["t"],
    },
    baseQuery: tableQuery("t"),
    baseSchema: sch,
    viewParams,
    initialViewParams: viewParams,
  });
  return new AppState()
    .set("initialized", true)
    .set("viewState", viewState)
    .set("showRecordCount", false) as AppState;
}

interface HarnessProps {}

const Harness: React.FunctionComponent<
  HarnessProps & { appState: AppState; stateRef: StateRef<AppState> }
> = ({ appState, stateRef }) => (
  <div>
    <ResultsPane appState={appState} stateRef={stateRef} />
    <CommandBar appState={appState} stateRef={stateRef} />
  </div>
);

function renderHarness(sch: Schema = schema): StateRef<AppState> {
  const stateRef = mkRef(mkAppState(sch));
  const [App] = refContainer<AppState, HarnessProps>(stateRef, Harness);
  render(<App />);
  return stateRef;
}

const typeCommand = (text: string) => {
  const input = screen.getByTestId("command-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  return input;
};

beforeEach(() => {
  resetEntryIds();
  interruptMock.mockClear();
  getDatasetInfoMock.mockClear();
  setMaterializedMock.mockClear();
  getMaterializeEstimateMock.mockClear();
});

describe("CommandBar", () => {
  test("Enter executes a command, appends a result, clears input, opens pane", async () => {
    const stateRef = renderHarness();
    const input = typeCommand("sum a");
    fireEvent.keyDown(input, { key: "Enter" });

    const entryEl = await screen.findByTestId("result-entry");
    expect(entryEl.textContent).toContain("sum a");

    const st = mutableGet(stateRef);
    expect(st.commandResults.size).toBe(1);
    expect(st.commandResults.get(0)!.status).toBe("ok");
    expect(st.resultsPaneOpen).toBe(true);
    expect(input.value).toBe("");

    // semantic table with summarize headers and values
    const table = entryEl.querySelector("table.command-result-table");
    expect(table).not.toBeNull();
    const headers = Array.from(table!.querySelectorAll("th")).map(
      (th) => th.textContent
    );
    expect(headers).toEqual(["Variable", "N", "Mean", "Std. dev.", "Min", "Max"]);
    const cells = Array.from(table!.querySelectorAll("tbody td")).map(
      (td) => td.textContent
    );
    expect(cells).toEqual(["a", "3", "2", "1", "1", "3"]);

    // generated SQL is present and expandable
    const sqlDetails = await screen.findByTestId("entry-sql");
    expect(sqlDetails.querySelector("pre")!.textContent).toContain(
      "stddev_samp"
    );
  });

  test("errors are shown near the input, preserve typed text, and append", async () => {
    const stateRef = renderHarness();
    const input = typeCommand("sum nope");
    fireEvent.keyDown(input, { key: "Enter" });

    const errEl = await screen.findByTestId("command-bar-error");
    expect(errEl.textContent).toContain("unknown variable 'nope'");
    expect(input.value).toBe("sum nope");

    const st = mutableGet(stateRef);
    expect(st.commandResults.size).toBe(1);
    expect(st.commandResults.get(0)!.status).toBe("error");
    expect(st.resultsPaneOpen).toBe(true);

    const entryErr = await screen.findByTestId("entry-error");
    expect(entryErr.textContent).toContain("unknown variable 'nope'");
  });

  test("up/down arrows navigate command history", async () => {
    renderHarness();
    let input = typeCommand("sum a");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await screen.findByTestId("result-entry");

    input = typeCommand("sum b");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("result-entry").length).toBe(2)
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((screen.getByTestId("command-input") as HTMLInputElement).value).toBe(
      "sum b"
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((screen.getByTestId("command-input") as HTMLInputElement).value).toBe(
      "sum a"
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((screen.getByTestId("command-input") as HTMLInputElement).value).toBe(
      "sum b"
    );
  });

  test("PageUp recalls the last submitted command", async () => {
    renderHarness();
    const input = typeCommand("sum a");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await screen.findByTestId("result-entry");
    expect(input.value).toBe("");

    fireEvent.keyDown(input, { key: "PageUp" });
    expect(input.value).toBe("sum a");
  });

  test("Tab completes variables and quotes names that need it", () => {
    renderHarness();
    const input = typeCommand("sum has");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("sum `has space`");
  });

  test("Tab does not treat the command token as a variable", () => {
    renderHarness();
    const input = typeCommand("s");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("s");
  });

  test("Tab with multiple matches opens a completion menu", () => {
    const multiSchema = mkSchema([
      ["price", "DOUBLE"],
      ["price_usd", "DOUBLE"],
      ["qty", "INTEGER"],
    ]);
    renderHarness(multiSchema);
    const input = typeCommand("sum pr");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Tab" });

    // the typed prefix extends to the longest common prefix of the
    // candidates while the menu stays open
    expect(input.value).toBe("sum price");
    const items = screen.getAllByTestId("command-completion-item");
    expect(items.map((it) => it.textContent)).toEqual([
      "price",
      "price_usd",
    ]);
    expect(items[0].className).toContain("selected");

    // arrow keys move the highlight instead of navigating history
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getAllByTestId("command-completion-item")[1].className
    ).toContain("selected");

    // Enter accepts the highlighted candidate and closes the menu
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("sum price_usd");
    expect(screen.queryByTestId("command-completion-menu")).toBeNull();
  });

  test("Escape dismisses the completion menu without changing input", () => {
    const multiSchema = mkSchema([
      ["price", "DOUBLE"],
      ["price_usd", "DOUBLE"],
    ]);
    renderHarness(multiSchema);
    // "price" is already the longest common prefix, so Tab only opens the menu
    const input = typeCommand("sum price");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByTestId("command-completion-menu")).not.toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("command-completion-menu")).toBeNull();
    expect(input.value).toBe("sum price");
  });

  test("Tab extends to the longest common prefix and keeps the menu open", () => {
    const multiSchema = mkSchema([
      ["google_labels1", "VARCHAR"],
      ["google_labels2", "VARCHAR"],
      ["google_labels3", "VARCHAR"],
      ["google_labels4", "VARCHAR"],
      ["google_labels5", "VARCHAR"],
    ]);
    renderHarness(multiSchema);
    const input = typeCommand("bro google_la");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Tab" });

    expect(input.value).toBe("bro google_labels");
    const items = screen.getAllByTestId("command-completion-item");
    expect(items.length).toBe(5);

    // picking a candidate still replaces the whole token
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("bro google_labels2");
    expect(screen.queryByTestId("command-completion-menu")).toBeNull();
  });

  test("clicking a completion menu item inserts it", () => {
    const multiSchema = mkSchema([
      ["price", "DOUBLE"],
      ["price_usd", "DOUBLE"],
    ]);
    renderHarness(multiSchema);
    const input = typeCommand("sum pr");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Tab" });

    fireEvent.mouseDown(screen.getAllByTestId("command-completion-item")[1]);
    expect(input.value).toBe("sum price_usd");
    expect(screen.queryByTestId("command-completion-menu")).toBeNull();
  });

  test("cell-contents bar spells out the focused cell", () => {
    const st = mkAppState().set("focusedCell", {
      obs: 4,
      columnDisplayName: "make",
      value: "Buick Century",
    }) as AppState;
    render(<CellContentBar appState={st} />);
    expect(screen.getByTestId("cell-content-label").textContent).toBe(
      "make[4]"
    );
    expect(screen.getByTestId("cell-content-value").textContent).toBe(
      "Buick Century"
    );
  });

  test("formatCellValueText renders values plainly, without HTML entities", () => {
    const viewParams = new ViewParams({
      displayColumns: schema.columns.slice(),
    });
    // list/object values format as JSON with real quotes, not &#x22;
    expect(
      formatCellValueText(viewParams, schema, "s", [
        "American Food",
        "Mexican Food",
      ])
    ).toBe('["American Food","Mexican Food"]');
    // strings pass through untouched, including quotes and ampersands
    expect(formatCellValueText(viewParams, schema, "s", 'say "hi" & bye')).toBe(
      'say "hi" & bye'
    );
    expect(formatCellValueText(viewParams, schema, "a", 42)).toBe("42");
    expect(formatCellValueText(viewParams, schema, "s", null)).toBe("");
  });

  test("cell-contents bar is empty with no focused cell", () => {
    render(<CellContentBar appState={mkAppState()} />);
    expect(screen.getByTestId("cell-content-label").textContent).toBe("");
    expect(screen.getByTestId("cell-content-value").textContent).toBe("");
  });

  test("Break interrupts the active connection", async () => {
    const stateRef = renderHarness();
    act(() => {
      update(
        stateRef,
        (st) => st.set("commandRunning", true) as AppState
      );
    });
    fireEvent.click(screen.getByTestId("command-break-button"));
    await waitFor(() => expect(interruptMock).toHaveBeenCalledTimes(1));
  });

  test("browse appends an entry but does not auto-open the pane", async () => {
    const stateRef = renderHarness();
    const input = typeCommand("bro a if b > 1");
    fireEvent.keyDown(input, { key: "Enter" });

    // wait for the entry to land in state
    await new Promise((resolve) => setTimeout(resolve, 0));
    const st = mutableGet(stateRef);
    expect(st.commandResults.size).toBe(1);
    expect(st.commandResults.get(0)!.kind).toBe("browse");
    expect(st.commandResults.get(0)!.sql.length).toBeGreaterThan(0);
    expect(st.resultsPaneOpen).toBe(false);
    // grid state updated: displayColumns projected to ['a']
    expect(st.viewState.viewParams.displayColumns).toEqual(["a"]);
    expect(st.viewState.viewParams.filterExp.opArgs.length).toBe(1);
    // browse only narrows the grid's displayColumns; it must not narrow
    // which variables subsequent commands can resolve (that's reserved
    // for keep/drop/order), so commandSchema still sees every column.
    expect(commandSchema(st).columns).toEqual(
      st.viewState.baseSchema.columns
    );
  });

  test("hiding a column via the sidebar does not block commands on it", async () => {
    const stateRef = renderHarness();
    act(() => {
      toggleShown("b", stateRef);
    });
    expect(
      mutableGet(stateRef).viewState.viewParams.displayColumns
    ).not.toContain("b");

    const input = typeCommand("sum b");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await screen.findByTestId("result-entry");

    const st = mutableGet(stateRef);
    expect(st.commandResults.get(0)!.status).toBe("ok");
  });

  test("drop removes a variable from subsequent command resolution", async () => {
    const stateRef = renderHarness();
    let input = typeCommand("drop b");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await screen.findByTestId("result-entry");

    input = typeCommand("sum b");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("result-entry").length).toBe(2)
    );

    const st = mutableGet(stateRef);
    expect(st.commandResults.get(0)!.status).toBe("ok"); // the drop itself
    expect(st.commandResults.get(1)!.status).toBe("error"); // sum b now unresolvable
  });
});

describe("ResultsPane", () => {
  test("toggle button shows/hides; clear empties history", async () => {
    const stateRef = renderHarness();
    expect(screen.queryByTestId("results-pane")).toBeNull();

    fireEvent.click(screen.getByTestId("results-toggle-button"));
    expect(screen.getByTestId("results-pane")).not.toBeNull();

    // run a command, then clear
    const input = typeCommand("sum a");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("result-entry");

    fireEvent.click(screen.getByTestId("results-clear-button"));
    expect(mutableGet(stateRef).commandResults.size).toBe(0);
    expect(screen.queryByTestId("result-entry")).toBeNull();
    // pane remains open after clearing
    expect(screen.getByTestId("results-pane")).not.toBeNull();

    fireEvent.click(screen.getByTestId("results-close-button"));
    expect(screen.queryByTestId("results-pane")).toBeNull();
  });

  test("entries accumulate in order (append-only)", async () => {
    renderHarness();
    let input = typeCommand("sum a");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("result-entry");
    input = typeCommand("sum nope");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("entry-error");

    const entries = screen.getAllByTestId("result-entry");
    expect(entries.length).toBe(2);
    expect(entries[0].textContent).toContain("sum a");
    expect(entries[1].textContent).toContain("sum nope");
  });
});

describe("command helpers", () => {
  test("formats safe and quoted variable names", () => {
    expect(formatVariableForCommand("price")).toBe("price");
    expect(formatVariableForCommand("has space")).toBe("`has space`");
    expect(formatVariableForCommand("if")).toBe("`if`");
    expect(formatVariableForCommand("a`b")).toBe("`a``b`");
  });
});

describe("ColumnSelector", () => {
  test("search filters columns by name or type", () => {
    const appState = mkAppState();
    const stateRef = mkRef(appState);
    render(
      <ColumnSelector
        schema={schema}
        viewParams={appState.viewState.viewParams}
        stateRef={stateRef}
      />
    );
    expect(screen.getAllByTestId("column-selector-row").length).toBe(4);

    fireEvent.change(screen.getByTestId("column-search-input"), {
      target: { value: "space" },
    });
    const rows = screen.getAllByTestId("column-selector-row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("has space");

    fireEvent.change(screen.getByTestId("column-search-input"), {
      target: { value: "double" },
    });
    expect(screen.getAllByTestId("column-selector-row")[0].textContent).toContain(
      "b"
    );
  });

  test("dragging the header handle widens the name column", () => {
    const appState = mkAppState();
    const stateRef = mkRef(appState);
    const { container } = render(
      <ColumnSelector
        schema={schema}
        viewParams={appState.viewState.viewParams}
        stateRef={stateRef}
      />
    );
    const tables = container.querySelectorAll("table");
    const initialWidth = (tables[0] as HTMLElement).style.width;
    const handle = screen.getByTestId("column-name-resize-handle");
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 160 });
    fireEvent.mouseUp(document);
    const newTables = container.querySelectorAll("table");
    const newWidth = (newTables[0] as HTMLElement).style.width;
    expect(parseInt(newWidth, 10)).toBe(parseInt(initialWidth, 10) + 60);
    // header and body tables stay in sync
    expect((newTables[1] as HTMLElement).style.width).toBe(newWidth);
  });

  test("all-columns checkbox only affects search matches", () => {
    const appState = mkAppState();
    const stateRef = mkRef(appState);
    render(
      <ColumnSelector
        schema={schema}
        viewParams={appState.viewState.viewParams}
        stateRef={stateRef}
      />
    );
    // narrow to the single "has space" column, then untick "All Matching"
    fireEvent.change(screen.getByTestId("column-search-input"), {
      target: { value: "space" },
    });
    fireEvent.click(screen.getByTestId("column-select-all-check"));
    expect(
      mutableGet(stateRef).viewState.viewParams.displayColumns
    ).toEqual(["a", "b", "s"]);

    // ticking it again restores only the matching column
    fireEvent.click(screen.getByTestId("column-select-all-check"));
    expect(
      mutableGet(stateRef).viewState.viewParams.displayColumns
    ).toEqual(["a", "b", "s", "has space"]);
  });
});

describe("Footer", () => {
  test("shows disk and memory sizes from the connection", async () => {
    const appState = mkAppState();
    const stateRef = mkRef(appState);
    render(<Footer appState={appState} stateRef={stateRef} />);
    const size = await screen.findByTestId("footer-dataset-size");
    expect(size.textContent).toBe("Disk 1.5 KiB · Memory 5 MiB");
    expect(getDatasetInfoMock).toHaveBeenCalledWith(
      appState.viewState.dsPath
    );
  });

  test("formats byte units", () => {
    expect(formatByteSize(12)).toBe("12 B");
    expect(formatByteSize(1024)).toBe("1 KiB");
    expect(formatByteSize(1024 * 1024)).toBe("1 MiB");
  });

  const GIB = 1024 ** 3;
  const matInfo = (over: object = {}) => ({
    sourceSizeBytes: 1536,
    memorySizeBytes: 5 * 1024 * 1024,
    canMaterialize: true,
    materialized: false,
    spillBytes: null,
    systemFreeMemBytes: 8 * GIB,
    systemTotalMemBytes: 16 * GIB,
    ...over,
  });

  async function renderFooterBlock(): Promise<HTMLElement> {
    const appState = mkAppState();
    const stateRef = mkRef(appState);
    render(<Footer appState={appState} stateRef={stateRef} />);
    return await screen.findByTestId("footer-materialize");
  }

  test("switch materializes immediately when the estimate fits", async () => {
    getDatasetInfoMock.mockResolvedValue(matInfo());
    getMaterializeEstimateMock.mockResolvedValue({
      estimatedBytes: 1 * GIB,
      systemFreeMemBytes: 8 * GIB,
      systemTotalMemBytes: 16 * GIB,
    });
    const block = await renderFooterBlock();
    fireEvent.click(within(block).getByRole("checkbox"));
    await waitFor(() =>
      expect(setMaterializedMock).toHaveBeenCalledWith(
        expect.anything(),
        true
      )
    );
    expect(screen.queryByText("Load anyway")).toBeNull();
  });

  test("pre-flight alert warns when the estimate exceeds free memory", async () => {
    getDatasetInfoMock.mockResolvedValue(matInfo());
    getMaterializeEstimateMock.mockResolvedValue({
      estimatedBytes: 12 * GIB,
      systemFreeMemBytes: 2 * GIB,
      systemTotalMemBytes: 16 * GIB,
    });
    const block = await renderFooterBlock();
    fireEvent.click(within(block).getByRole("checkbox"));

    // cancel: nothing is loaded
    const cancelBtn = await screen.findByText("Cancel");
    expect(screen.getByText("12 GiB")).toBeTruthy();
    expect(screen.getByText("2 GiB")).toBeTruthy();
    fireEvent.click(cancelBtn);
    await waitFor(() =>
      expect(screen.queryByText("Load anyway")).toBeNull()
    );
    expect(setMaterializedMock).not.toHaveBeenCalled();

    // confirm: load proceeds
    fireEvent.click(within(block).getByRole("checkbox"));
    fireEvent.click(await screen.findByText("Load anyway"));
    await waitFor(() =>
      expect(setMaterializedMock).toHaveBeenCalledWith(
        expect.anything(),
        true
      )
    );
  });

  test("warning icon appears when the in-memory copy spills to disk", async () => {
    getDatasetInfoMock.mockResolvedValue(
      matInfo({ materialized: true, spillBytes: 123 * 1024 * 1024 })
    );
    await renderFooterBlock();
    const warn = await screen.findByTestId("footer-materialize-warning");
    expect(warn.getAttribute("title")).toContain("spilled to disk");
    expect(warn.getAttribute("title")).toContain("123 MiB");
  });

  test("warning icon appears when system memory is low", async () => {
    getDatasetInfoMock.mockResolvedValue(
      matInfo({
        materialized: true,
        spillBytes: 0,
        systemFreeMemBytes: 0.5 * GIB,
      })
    );
    await renderFooterBlock();
    const warn = await screen.findByTestId("footer-materialize-warning");
    expect(warn.getAttribute("title")).toContain("System memory is low");
  });

  test("no warning icon for a healthy in-memory copy", async () => {
    getDatasetInfoMock.mockResolvedValue(
      matInfo({ materialized: true, spillBytes: 0 })
    );
    await renderFooterBlock();
    expect(screen.queryByTestId("footer-materialize-warning")).toBeNull();
  });

  test("failed materialization surfaces a toast", async () => {
    getDatasetInfoMock.mockResolvedValue(matInfo());
    getMaterializeEstimateMock.mockResolvedValue({
      estimatedBytes: 1024,
      systemFreeMemBytes: 8 * GIB,
      systemTotalMemBytes: 16 * GIB,
    });
    setMaterializedMock.mockRejectedValueOnce(
      new Error("Out of Memory Error: boom")
    );
    const block = await renderFooterBlock();
    fireEvent.click(within(block).getByRole("checkbox"));
    await screen.findByText(
      /Failed to load the dataset into memory: Out of Memory Error: boom/
    );
  });
});

describe("formatCell", () => {
  test("formats numbers and nulls", () => {
    expect(formatCell(null)).toBe("");
    expect(formatCell(3)).toBe("3");
    expect(formatCell(1234567)).toBe("1,234,567");
    // grouping starts at five digits: years stay comma-free
    expect(formatCell(2024)).toBe("2024");
    expect(formatCell(9999)).toBe("9999");
    expect(formatCell(10000)).toBe("10,000");
    expect(formatCell(-2024)).toBe("-2024");
    expect(formatCell(4.333333333333333)).toBe("4.333333");
    expect(formatCell(1.5275252316519468)).toBe("1.527525");
    expect(formatCell("text")).toBe("text");
  });
});
