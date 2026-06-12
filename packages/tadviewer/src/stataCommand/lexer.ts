/**
 * Lexer for the Stata-like command language.
 *
 * Token forms:
 * - WORD:    [A-Za-z_][A-Za-z0-9_]* (command names, variable names, keywords)
 * - QUOTED:  `...` backtick-quoted identifier; doubled backtick for a
 *            literal backtick. Allows spaces, punctuation, reserved words,
 *            and embedded double quotes in variable names.
 * - NUMBER:  123, 1.5, .5, 2e10, 1.5E-3 (no sign; unary minus is handled
 *            by the parser)
 * - STRING:  '...' or "..." with the quote character doubled to escape it
 *            ('it''s', "say ""hi""")
 * - OP:      ( ) & | == = != ~= <= >= < >
 */

import { StataCommandError } from "./errors";

export type TokenType =
  | "word"
  | "quotedIdent"
  | "number"
  | "string"
  | "op"
  | "eof";

export interface Token {
  type: TokenType;
  /** decoded text: identifier name, string contents, number text, operator */
  text: string;
  /** 0-based character offset of the token start in the input */
  pos: number;
}

const isWordStart = (ch: string) => /[A-Za-z_]/.test(ch);
const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch: string) => ch >= "0" && ch <= "9";

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    // backtick-quoted identifier
    if (ch === "`") {
      const start = i;
      i++;
      let name = "";
      let closed = false;
      while (i < n) {
        if (input[i] === "`") {
          if (input[i + 1] === "`") {
            name += "`";
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else {
          name += input[i];
          i++;
        }
      }
      if (!closed) {
        throw new StataCommandError(
          "lex",
          "unterminated quoted variable name (missing closing `)",
          start
        );
      }
      if (name.length === 0) {
        throw new StataCommandError(
          "lex",
          "empty quoted variable name",
          start
        );
      }
      tokens.push({ type: "quotedIdent", text: name, pos: start });
      continue;
    }

    // string literal, single- or double-quoted, doubled quote to escape
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      let value = "";
      let closed = false;
      while (i < n) {
        if (input[i] === quote) {
          if (input[i + 1] === quote) {
            value += quote;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else {
          value += input[i];
          i++;
        }
      }
      if (!closed) {
        throw new StataCommandError(
          "lex",
          `unterminated string literal (missing closing ${quote})`,
          start
        );
      }
      tokens.push({ type: "string", text: value, pos: start });
      continue;
    }

    // number: digits, optional fraction, optional exponent; or leading '.'
    if (isDigit(ch) || (ch === "." && isDigit(input[i + 1]))) {
      const start = i;
      while (i < n && isDigit(input[i])) i++;
      if (input[i] === "." && isDigit(input[i + 1])) {
        i++;
        while (i < n && isDigit(input[i])) i++;
      } else if (input[i] === "." && start < i) {
        // trailing dot like "1." -- allow, consistent with SQL numerics
        i++;
      }
      if (input[i] === "e" || input[i] === "E") {
        let j = i + 1;
        if (input[j] === "+" || input[j] === "-") j++;
        if (isDigit(input[j])) {
          j++;
          while (j < n && isDigit(input[j])) j++;
          i = j;
        }
      }
      const text = input.slice(start, i);
      if (i < n && isWordChar(input[i])) {
        throw new StataCommandError(
          "lex",
          `invalid number '${text + input[i]}...'`,
          start
        );
      }
      tokens.push({ type: "number", text, pos: start });
      continue;
    }

    // word
    if (isWordStart(ch)) {
      const start = i;
      while (i < n && isWordChar(input[i])) i++;
      tokens.push({ type: "word", text: input.slice(start, i), pos: start });
      continue;
    }

    // operators
    const two = input.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "~=" || two === "<=" || two === ">=") {
      tokens.push({ type: "op", text: two, pos: i });
      i += 2;
      continue;
    }
    if ("()&|<>=-".includes(ch)) {
      tokens.push({ type: "op", text: ch, pos: i });
      i++;
      continue;
    }

    throw new StataCommandError("lex", `unexpected character '${ch}'`, i);
  }

  tokens.push({ type: "eof", text: "", pos: n });
  return tokens;
}
