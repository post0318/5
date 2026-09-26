/**
 * 결정적 HTML 표 파서 — 손익계산서 표를 코드로 읽는다(모델 없음, 비용 0).
 *
 * 입력은 locate.mjs 의 간소화 HTML 창(table/tr/td + colspan 만 남은 것). 출력은 모델 추출과
 * **같은 형식**(prompt.mjs 의 SCHEMA)이라 같은 validate 를 그대로 통과해야 저장된다.
 *
 * 읽는 방법
 *  - 행마다 칸을 colspan 으로 격자 위치에 놓는다.
 *  - 첫 "데이터 행"(첫 칸에 제목 + 숫자 칸 1개 이상) 앞의 행들이 열 머리글. 가장 아래 머리글 행의
 *    비어 있지 않은 칸들이 데이터 열 구간을 정하고, 위 머리글 행 중 그 구간과 겹치는 칸 글자를 위→아래로
 *    이어 열 제목을 만든다("Three Months Ended" + "June 27, 2026").
 *  - 숫자는 열 구간 안의 칸 글자를 이어 읽는다 — "$" 칸, "(" / ")" 가 따로 떨어진 칸, "%" 칸, 각주 표시
 *    ("1,234 (1)" 의 "(1)", "1,234*") 처리. 괄호 = 음수, 대시(—, –, -) = 값 없음.
 *  - 행 제목: 첫 칸 글자(줄바꿈은 공백으로). 숫자 없는 제목 행이 ":" 로 끝나지 않고 다음 행 제목이
 *    소문자로 시작하면 한 제목이 줄바꿈된 것으로 보고 잇는다.
 *  - 구역 제목(sectionLabel): 숫자 없는 제목 행. "Total …" 행이나 빈 행이 나오면 끝난다.
 *  - 단위: 창 평문의 "(In thousands/millions/billions …)" 괄호 문구. 주당 금액 행은 1, 주식 수 행은
 *    문구에 주식 수 배수가 따로 있으면("shares … in thousands") 그 배수, 없으면 문구 배수.
 *  - 소계(isSubtotal): 모델은 괘선을 보지만 파서는 제목 글자로만 판단(키·값 비교에는 안 쓰임).
 *
 * 하나라도 확신이 없으면(열 구간 밖 숫자, 머리글 없음, 숫자 형식 이상) null 을 돌려주고 사유를 남긴다 —
 * 그 공시는 LLM 으로 넘어간다.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeEntities } from "./locate.mjs";

export const PARSER_VERSION = "parser-v1";
/** 파서 소스 해시 — 파서를 고치면 바뀌어, 어떤 파서로 읽었는지 값마다 구분된다 */
export const PARSER_HASH = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex")
  .slice(0, 16);

const clean = (s) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/[\s ]+/g, " ").trim();

/** 간소화 HTML 표 → [{ cells: [{ text, start, span }] }] */
function gridRows(tableHtml) {
  const rows = [];
  for (const trm of tableHtml.matchAll(/<tr>([\s\S]*?)(?=<tr>|<\/table>|$)/g)) {
    const body = trm[1].replace(/<\/tr>[\s\S]*$/, "");
    const cells = [];
    let pos = 0;
    for (const cm of body.matchAll(/<t[dh]([^>]*)>([\s\S]*?)(?=<t[dh][\s>]|$)/g)) {
      const span = Number(/colspan=(\d+)/.exec(cm[1])?.[1] ?? 1);
      cells.push({ text: clean(cm[2].replace(/<\/t[dh]>/g, "")), start: pos, span });
      pos += span;
    }
    rows.push({ cells });
  }
  return rows;
}

const NUM_CORE = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;
const FOOTNOTE = String.raw`(?:\s*\(\s*(?:\d|[a-z])\s*\)|\s*\*+|\s*\[\d\])?`;
const DASH_RE = /^[—–-]+$/;
// 한 열 구간의 글자를 이어 붙인 것: [$] [(] [$] 숫자 [각주] [)] [%] [각주]
const VALUE_RE = new RegExp(String.raw`^\$?\s*(\()?\s*\$?\s*(-)?\s*(${NUM_CORE}|[—–-])${FOOTNOTE}\s*(\))?\s*(%)?${FOOTNOTE}$`);

function isNumericish(text) {
  return VALUE_RE.test(text) && /\d|[—–]/.test(text);
}

function findCaption(windowText) {
  const m = /\((?:[^()]|\([^()]*\))*?\bin\s+(?:thousands|millions|billions)\b(?:[^()]|\([^()]*\))*\)/i.exec(windowText);
  return m ? m[0] : "";
}

function captionScale(caption) {
  const m = /\bin\s+(thousands|millions|billions)\b/i.exec(caption);
  return m ? { thousands: 1e3, millions: 1e6, billions: 1e9 }[m[1].toLowerCase()] : 1;
}

function sharesScale(caption, base) {
  // "number of shares, which are reflected in thousands" / "shares in thousands"
  const m = /shares?[^()]*?\b(?:reflected\s+)?in\s+(thousands|millions|billions)\b/i.exec(caption);
  return m ? { thousands: 1e3, millions: 1e6, billions: 1e9 }[m[1].toLowerCase()] : base;
}

function unitKindOf(label, section, text) {
  if (/%/.test(text)) return "percent";
  const PER_SHARE = /per[\s-]+(?:common\s+|ordinary\s+)?share\b/i;
  if (PER_SHARE.test(label)) return "per_share";
  if (/\bshares\b/i.test(`${section} ${label}`)) return "shares";
  if (PER_SHARE.test(section)) return "per_share";
  return "currency";
}

const SUBTOTAL_RE = /^(?:total\b|gross (?:margin|profit)|operating (?:income|loss|profit)|income \(loss\) from operations|(?:net )?income(?: \(loss\))? before|loss before|net (?:income|loss|earnings)|comprehensive income|interest and other (?:income|loss|expense))/i;

/**
 * @param {string} windowHtml locate 의 간소화 HTML
 * @param {string} windowText locate 의 평문
 * @returns {{ json: object | null; reason?: string }}
 */
export function parseIncomeStatement(windowHtml, windowText) {
  const tStart = windowHtml.search(/<table>/);
  if (tStart < 0) return { json: null, reason: "표 없음" };
  const before = windowHtml.slice(0, tStart);
  const titleLine = before
    .split("\n")
    .map((l) => clean(l))
    .filter((l) => /STATEMENTS?\s+OF\b|INCOME\s+STATEMENTS?/i.test(l))
    .at(-1);
  const tableTitle = titleLine ?? "";
  const unitCaption = findCaption(windowText);
  const capScale = captionScale(unitCaption);
  const shScale = sharesScale(unitCaption, capScale);

  const rows = gridRows(windowHtml.slice(tStart));
  const labelOf = (r) => (r.cells[0]?.text ?? "");
  const hasNumber = (r) => r.cells.slice(1).some((c) => isNumericish(c.text));
  const firstData = rows.findIndex((r) => labelOf(r) && !isNumericish(labelOf(r)) && hasNumber(r));
  if (firstData < 0) return { json: null, reason: "데이터 행 없음" };

  // 열 구간: 데이터 행 바로 위에서부터 올라가며 비어 있지 않은 칸이 있는 첫 머리글 행
  const headerRows = rows.slice(0, firstData).filter((r) => r.cells.some((c, i) => i > 0 && c.text));
  if (!headerRows.length) return { json: null, reason: "열 머리글 없음" };
  const bottom = headerRows.at(-1);
  const spans = bottom.cells.filter((c, i) => i > 0 && c.text).map((c) => ({ start: c.start, end: c.start + c.span }));
  const columns = spans.map((sp, columnIndex) => {
    const parts = [];
    for (const hr of headerRows) {
      for (const c of hr.cells) {
        if (!c.text || c.start === 0 && hr.cells.indexOf(c) === 0) continue;
        if (c.start < sp.end && c.start + c.span > sp.start) parts.push(c.text);
      }
    }
    return { columnIndex, header: parts.join(" ").replace(/\s+/g, " ").trim() };
  });
  const colOf = (pos) => spans.findIndex((sp) => pos >= sp.start && pos < sp.end);

  const outRows = [];
  let section = "";
  let pendingLabel = "";
  let rowIndex = 0;
  // 가장 아래 머리글 행 다음부터 — 첫 데이터 행 위의 제목 행(예: "Net sales:")도 포함
  for (let i = rows.indexOf(bottom) + 1; i < rows.length; i++) {
    const r = rows[i];
    let label = labelOf(r);
    const numeric = hasNumber(r);
    if (!label && !numeric) {
      // 빈 행: 다음 제목 행 전까지 "Total …" 행이 나오면 같은 구역이 이어지는 것(중간 여백), 아니면 구역 끝
      if (r.cells.every((c) => !c.text)) {
        let keeps = false;
        for (let j = i + 1; j < rows.length; j++) {
          const lj = labelOf(rows[j]);
          if (!lj) continue;
          if (!hasNumber(rows[j])) break;
          if (/^total\b/i.test(lj)) {
            keeps = true;
            break;
          }
        }
        if (!keeps) section = "";
      }
      continue;
    }
    if (!numeric) {
      const next = rows[i + 1];
      const nextLabel = next ? labelOf(next) : "";
      if (!/:$/.test(label) && /^[a-z]/.test(nextLabel)) {
        pendingLabel = label; // 줄바꿈된 제목 — 다음 행과 잇는다
        continue;
      }
      section = label;
      outRows.push({ rowIndex: rowIndex++, label, sectionLabel: "", isSubtotal: false, cells: [] });
      continue;
    }
    if (pendingLabel) {
      label = `${pendingLabel} ${label}`;
      pendingLabel = "";
    }
    // 열별로 칸 글자 모으기 — 구간 밖 칸은 ")" "%" 같은 꼬리 기호만 허용(바로 앞 열에 붙임)
    const buf = columns.map(() => []);
    let lastCol = -1;
    for (const c of r.cells.slice(1)) {
      if (!c.text) continue;
      const ci = colOf(c.start);
      if (ci >= 0) {
        buf[ci].push(c.text);
        lastCol = ci;
      } else if (/^[)%]+$|^\)\s*%$/.test(c.text) && lastCol >= 0) {
        buf[lastCol].push(c.text);
      } else if (c.text === "$" || c.text === "(" || c.text === "$ (") {
        // 다음 열 앞의 기호 — 다음 열 칸과 함께 읽히도록 보류
        const nextCol = spans.findIndex((sp) => sp.start > c.start);
        if (nextCol < 0) return { json: null, reason: `열 밖 기호 "${c.text}" (${label})` };
        buf[nextCol].push(c.text);
      } else {
        return { json: null, reason: `열 구간 밖 칸 "${c.text}" (${label})` };
      }
    }
    const sec = section;
    const cells = [];
    for (let ci = 0; ci < columns.length; ci++) {
      if (!buf[ci].length) continue;
      const joined = buf[ci].join(" ").replace(/\s+/g, " ").trim();
      if (joined === "$") continue;
      const m = VALUE_RE.exec(joined);
      if (!m) return { json: null, reason: `숫자 형식 아님 "${joined}" (${label})` };
      const [, open, minus, core, close, pct] = m;
      if (Boolean(open) !== Boolean(close) && !(open && pct)) {
        return { json: null, reason: `괄호 짝 안 맞음 "${joined}" (${label})` };
      }
      const unitKind = pct ? "percent" : unitKindOf(label, sec, joined);
      if (DASH_RE.test(core)) {
        cells.push({ columnIndex: ci, printed: core, negative: false, number: null, scale: unitKind === "currency" ? capScale : unitKind === "shares" ? shScale : 1, unitKind });
        continue;
      }
      const negative = Boolean(open || minus);
      const mag = Number(core.replace(/,/g, ""));
      const scale = unitKind === "currency" ? capScale : unitKind === "shares" ? shScale : 1;
      cells.push({ columnIndex: ci, printed: core, negative, number: negative ? -mag : mag, scale, unitKind });
    }
    outRows.push({ rowIndex: rowIndex++, label, sectionLabel: sec, isSubtotal: SUBTOTAL_RE.test(label) && !/per[\s-]+(?:common\s+)?share\b/i.test(label), cells });
    if (/^total\b/i.test(label)) section = ""; // "Total …" 로 구역 끝
  }
  if (!outRows.some((r) => r.cells.length)) return { json: null, reason: "숫자 칸 없음" };
  return { json: { tableTitle, unitCaption, columns, rows: outRows } };
}
