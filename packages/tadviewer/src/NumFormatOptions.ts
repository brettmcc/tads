import * as Immutable from "immutable";
import { CellFormatter, ClickHandler, FormatOptions } from "./FormatOptions";

export interface NumFormatOptionsProps {
  type: string;
  commas: boolean;
  decimalPlaces: number | undefined;
  exponential: boolean;
  formatMethod: "toLocaleString" | "toString";
}

const defaultNumFormatOptionsProps: NumFormatOptionsProps = {
  type: "NumFormatOptions",
  commas: true,
  decimalPlaces: 2,
  exponential: false,
  formatMethod: "toString",
};

/**
 * Grouping only kicks in at five digits: 4-digit values like years
 * (2024) read better without a comma.
 */
export const GROUPING_MIN_MAGNITUDE = 10000;

const wantsGrouping = (val: number | bigint): boolean => {
  if (typeof val === "bigint") {
    const absVal = val < BigInt(0) ? -val : val;
    return absVal >= BigInt(GROUPING_MIN_MAGNITUDE);
  }
  return Math.abs(val) >= GROUPING_MIN_MAGNITUDE;
};

export class NumFormatOptions
  extends Immutable.Record(defaultNumFormatOptionsProps)
  implements NumFormatOptionsProps, FormatOptions
{
  public readonly type!: string;
  public readonly commas!: boolean;
  public readonly decimalPlaces!: number | undefined;
  public readonly exponential!: boolean;

  getFormatter(): CellFormatter {
    const mkFmtOpts = (grouping: boolean) => ({
      minimumFractionDigits: this.decimalPlaces,
      maximumFractionDigits: this.decimalPlaces,
      useGrouping: grouping,
    });
    const groupedOpts = mkFmtOpts(true);
    const ungroupedOpts = mkFmtOpts(false);

    const ff = (val?: any): string | undefined | null => {
      if (val == null) {
        return null;
      }

      let ret: string;

      if (this.formatMethod === "toString") {
        ret = val.toString();
      } else {
        if (this.exponential) {
          const expFmtOpts: BigIntToLocaleStringOptions = {
            notation: "scientific",
          };
          if (this.decimalPlaces) {
            expFmtOpts.minimumFractionDigits = this.decimalPlaces as any;
            expFmtOpts.maximumFractionDigits = this.decimalPlaces as any;
          }
          ret = val.toLocaleString(undefined, expFmtOpts);
        } else {
          const grouping = this.commas && wantsGrouping(val);
          ret = val.toLocaleString(
            undefined,
            grouping ? groupedOpts : ungroupedOpts
          );
        }
      }
      return ret;
    };

    return ff;
  }

  getClassName(): string | null {
    return "data-cell-numeric";
  }

  getClickHandler(): ClickHandler | null {
    return null;
  }
}
