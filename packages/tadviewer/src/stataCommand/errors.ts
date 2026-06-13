/**
 * Errors raised by the Stata command lexer, parser, and schema resolver.
 */

export type CommandErrorPhase = "lex" | "parse" | "resolve" | "plan";

export class StataCommandError extends Error {
  readonly name = "StataCommandError";
  /** which processing phase rejected the command */
  readonly phase: CommandErrorPhase;
  /** 0-based character offset into the command text, if known */
  readonly pos: number | undefined;

  constructor(phase: CommandErrorPhase, message: string, pos?: number) {
    super(message);
    this.phase = phase;
    this.pos = pos;
    // restore prototype chain (TS targeting older runtimes)
    Object.setPrototypeOf(this, StataCommandError.prototype);
  }
}

/**
 * Render an error with a caret marker under the offending position:
 *
 *   sum a iff b > 2
 *         ^
 *   unknown variable 'iff'
 */
export function formatCommandError(
  input: string,
  err: StataCommandError
): string {
  if (err.pos == null || err.pos < 0 || err.pos > input.length) {
    return err.message;
  }
  const caretLine = " ".repeat(err.pos) + "^";
  return `${input}\n${caretLine}\n${err.message}`;
}
