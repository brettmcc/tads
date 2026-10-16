import * as Immutable from "immutable";
import { ViewState } from "./ViewState";
import * as reltab from "reltab";
import { DataSourcePath, DataSourceId } from "reltab";
import { Timer } from "./Timer";
import { Activity } from "./components/defs";
import { CommandResultEntry } from "./commandState";
import { Expr } from "./stataCommand/ast";
/**
 * Immutable representation of application state
 *
 * Just a single view in a single untabbed window for now.
 */

export type ExportFormat = "csv" | "parquet";

export interface ParquetExportOptions {
  compression: "uncompressed" | "snappy" | "gzip" | "zstd";
}

export const defaultParquetExportOptions: ParquetExportOptions = {
  compression: "snappy",
};

/**
 * The grid cell that currently has focus, spelled out for the
 * Stata Browse-style cell-contents bar above the grid.
 */
export interface FocusedCellData {
  /** 1-based observation number, or null for aggregate/pivot rows */
  obs: number | null;
  columnDisplayName: string;
  /** formatted cell text, in full */
  value: string;
}

export interface AppStateProps {
  initialized: boolean; // Has main process initialization completed?

  windowTitle: string; // Usually just the table name or file name

  rtc: reltab.ReltabConnection | null;

  viewState: ViewState | null;
  exportBeginDialogOpen: boolean;
  exportProgressDialogOpen: boolean;
  exportFormat: ExportFormat;
  exportPath: string;
  exportPathBaseName: string;
  exportPercent: number;

  viewConfirmDialogOpen: boolean;
  viewConfirmSourcePath: DataSourcePath | null;

  appLoadingTimer: Timer;
  /**
   * True from window creation until the file we were launched with has been
   * handed to openDataSourcePath. Without it there's a gap after the first
   * render where nothing is loading *yet*, and the empty-state "Open Dataset"
   * button flashes before the dataset appears.
   */
  initialLoadPending: boolean;
  /**
   * Number of dataset opens in flight. Opens can overlap (e.g. a second
   * File > Open while the first is still importing), so this is a count:
   * whichever open finishes first mustn't take the spinner down under the
   * other.
   */
  pendingOpens: number;
  activity: Activity;
  showRecordCount: boolean;

  // Stata-style command bar state (session-only, not persisted):
  commandResults: Immutable.List<CommandResultEntry>;
  resultsPaneOpen: boolean;
  commandRunning: boolean;
  /** accumulated keep-if / drop-if dataset filter for the command session */
  sessionFilter: Expr | null;
  /**
   * accumulated keep/drop/order variable list for the command session, in
   * effect independent of the grid's displayColumns (which UI actions like
   * the column selector's show/hide checkbox also mutate). null means no
   * keep/drop/order command has run yet, so commands see every column in
   * baseSchema.
   */
  sessionColumns: string[] | null;

  /** grid cell shown in the cell-contents bar (session-only) */
  focusedCell: FocusedCellData | null;
}

const defaultAppStateProps: AppStateProps = {
  initialized: false,
  windowTitle: "",
  rtc: null,
  viewState: null,
  exportBeginDialogOpen: false,
  exportProgressDialogOpen: false,
  exportFormat: "parquet",
  exportPath: "",
  exportPathBaseName: "",
  exportPercent: 0,
  viewConfirmDialogOpen: false,
  viewConfirmSourcePath: null,
  appLoadingTimer: new Timer(),
  initialLoadPending: false,
  pendingOpens: 0,
  activity: "None",
  showRecordCount: true,
  commandResults: Immutable.List<CommandResultEntry>(),
  resultsPaneOpen: false,
  commandRunning: false,
  sessionFilter: null,
  sessionColumns: null,
  focusedCell: null,
};

export class AppState extends Immutable.Record(defaultAppStateProps) {
  public readonly initialized!: boolean; // Has main process initialization completed?

  public readonly windowTitle!: string; // Usually just the table name or file name

  public readonly rtc!: reltab.ReltabConnection;

  public readonly viewState!: ViewState;
  public readonly exportBeginDialogOpen!: boolean;
  public readonly exportProgressDialogOpen!: boolean;
  public readonly exportFormat!: ExportFormat;
  public readonly exportPath!: string;
  public readonly exportPathBaseName!: string;
  public readonly exportPercent!: number;
  public readonly viewConfirmDialogOpen!: boolean;
  public readonly viewConfirmSourcePath!: DataSourcePath | null;
  public readonly appLoadingTimer!: Timer;
  public readonly initialLoadPending!: boolean;
  public readonly pendingOpens!: number;
  public readonly activity!: Activity;
  public readonly showRecordCount!: boolean;
  public readonly commandResults!: Immutable.List<CommandResultEntry>;
  public readonly resultsPaneOpen!: boolean;
  public readonly commandRunning!: boolean;
  public readonly sessionFilter!: Expr | null;
  public readonly sessionColumns!: string[] | null;
  public readonly focusedCell!: FocusedCellData | null;
}
