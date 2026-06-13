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
  activity: Activity;
  showRecordCount: boolean;

  // Stata-style command bar state (session-only, not persisted):
  commandResults: Immutable.List<CommandResultEntry>;
  resultsPaneOpen: boolean;
  commandRunning: boolean;
  /** accumulated keep-if / drop-if dataset filter for the command session */
  sessionFilter: Expr | null;
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
  activity: "None",
  showRecordCount: true,
  commandResults: Immutable.List<CommandResultEntry>(),
  resultsPaneOpen: false,
  commandRunning: false,
  sessionFilter: null,
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
  public readonly activity!: Activity;
  public readonly showRecordCount!: boolean;
  public readonly commandResults!: Immutable.List<CommandResultEntry>;
  public readonly resultsPaneOpen!: boolean;
  public readonly commandRunning!: boolean;
  public readonly sessionFilter!: Expr | null;
}
