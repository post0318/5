/**
 * 모델 지시문·출력 스키마 — 모든 어댑터가 같은 것을 쓴다.
 * 내용을 바꾸면 PROMPT_HASH 가 바뀌어, 저장된 값마다 어떤 지시문으로 뽑았는지 구분된다.
 *
 * 원칙: 표에 인쇄된 그대로만 옮긴다. "매출"·"매출원가" 같은 개념 매핑, 계산, 재분류는 하지 않는다.
 */
import { createHash } from "node:crypto";

export const PROMPT_VERSION = "ref-is-v1";

export const INSTRUCTIONS = `You are transcribing a financial statement table from an SEC filing. The input is a simplified HTML excerpt that contains the income statement (statement of operations / earnings) table and the text just above it.

Transcribe EVERY row of that ONE table exactly as printed. Do not interpret, reclassify, rename, or compute anything.

Table-level fields:
- tableTitle: the statement title exactly as printed above the table (e.g. "CONSOLIDATED STATEMENTS OF OPERATIONS").
- unitCaption: the unit caption exactly as printed (e.g. "(In millions, except number of shares, which are reflected in thousands, and per-share amounts)"). Empty string if none is printed.
- columns: one entry per numeric data column, left to right. columnIndex starts at 0. header = the FULL header text for that column, combining the spanning header and the sub-header as printed (e.g. "Three Months Ended June 28, 2025", "Year Ended January 29, 2022"). If a spanning header covers several columns, repeat it in each column's header.

Row fields (one entry per table row, top to bottom, including heading rows that have no numbers):
- rowIndex: 0-based order in the table.
- label: the row label text exactly as printed (keep punctuation like ":" and parenthetical text).
- sectionLabel: the label of the nearest preceding heading row that this row is indented under (e.g. "Operating expenses:" or "Earnings per share:"); empty string if none.
- isSubtotal: true if the row is a total or subtotal line (typically printed with a rule above it, or labelled "Total ...", "Gross margin", "Operating income", "Net income"); otherwise false. This is a visual judgement only.
- cells: one entry per data column that has something printed in this row. Skip columns that are completely blank.
  - columnIndex: the index in columns.
  - printed: the number text exactly as printed, INCLUDING thousands separators and decimal point, but WITHOUT "$", "%", and WITHOUT the parentheses. If the cell shows a dash (—, –, -) meaning nil, printed = that dash character.
  - negative: true if the printed number is enclosed in parentheses or has a leading minus sign; otherwise false.
  - number: the numeric value of printed as a plain number, with the sign applied (negative → less than zero). null if printed is a dash. Do NOT apply the unit scale.
  - scale: the multiplier stated by the unit caption for THIS row (e.g. 1000000 for "In millions", 1000 for "In thousands"); 1 for per-share amounts or any row the caption excludes; use the caption's stated scale for share counts if the caption gives one for shares.
  - unitKind: "currency" for money amounts, "per_share" for per-share amounts, "shares" for share counts, "percent" for percentages, "other" otherwise.

Never invent rows or numbers. Every printed value must appear verbatim in the input.`;

export const SCHEMA = {
  type: "object",
  properties: {
    tableTitle: { type: "string" },
    unitCaption: { type: "string" },
    columns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          columnIndex: { type: "integer" },
          header: { type: "string" },
        },
        required: ["columnIndex", "header"],
      },
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rowIndex: { type: "integer" },
          label: { type: "string" },
          sectionLabel: { type: "string" },
          isSubtotal: { type: "boolean" },
          cells: {
            type: "array",
            items: {
              type: "object",
              properties: {
                columnIndex: { type: "integer" },
                printed: { type: "string" },
                negative: { type: "boolean" },
                number: { type: ["number", "null"] },
                scale: { type: "number" },
                unitKind: { type: "string", enum: ["currency", "per_share", "shares", "percent", "other"] },
              },
              required: ["columnIndex", "printed", "negative", "number", "scale", "unitKind"],
            },
          },
        },
        required: ["rowIndex", "label", "sectionLabel", "isSubtotal", "cells"],
      },
    },
  },
  required: ["tableTitle", "unitCaption", "columns", "rows"],
};

export const PROMPT_HASH = createHash("sha256")
  .update(PROMPT_VERSION + "\n" + INSTRUCTIONS + "\n" + JSON.stringify(SCHEMA))
  .digest("hex")
  .slice(0, 16);
