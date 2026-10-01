/**
 * 결정적(deterministic) 검증기 — 모델 응답을 원문 창과 대조한다.
 * 앱·검증기 로직을 쓰지 않는다. 판단 기준은 오직 "원문 창에 인쇄된 글자".
 *
 *  1) 스키마 일치(여기 있는 최소 JSON Schema 검사기)
 *  2) 인쇄된 숫자 문자열이 창 평문에 실제로 있는가(환각 차단 — 없으면 그 칸은 버린다)
 *  3) 괄호(음수) 여부가 원문과 맞는가, number 가 printed 를 그대로 옮긴 값인가
 *  4) 단위 문구에서 배수를 직접 읽어 모델의 scale 과 대조
 *  5) 열 제목에서 기간 말일·기간 길이를 파싱
 *  6) 배수 적용 값(달러·주식 수)을 정수로 계산(부동소수점 없이 BigInt)
 */

// ───────── 1) 최소 스키마 검사 ─────────
export function schemaErrors(value, schema, path = "$") {
  const errs = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual =
    value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
  if (!ok) {
    errs.push(`${path}: ${types.join("|")} 이어야 하는데 ${actual}`);
    return errs;
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: 허용값 아님(${value})`);
  if (actual === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: 없음`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) errs.push(...schemaErrors(value[k], sub, `${path}.${k}`));
    }
  }
  if (actual === "array" && schema.items) {
    value.forEach((v, i) => errs.push(...schemaErrors(v, schema.items, `${path}[${i}]`)));
  }
  return errs;
}

// ───────── 공통 도우미 ─────────
const norm = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DASHES = new Set(["—", "–", "-", "−", "— ", "--"]);

/** "4,462,383" → {intDigits:"4462383", frac:""}; 형식이 숫자가 아니면 null */
function parsePrinted(printed) {
  const s = printed.trim().replace(/^-/, "");
  if (!/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$|^\.\d+$/.test(s)) return null;
  const [i, f = ""] = s.replace(/,/g, "").split(".");
  return { intDigits: i || "0", frac: f };
}

/** 소수 문자열 × 10^k → 정수면 BigInt, 아니면 소수 문자열 */
function scaleExact({ intDigits, frac }, scale, negative) {
  const k = Math.round(Math.log10(scale));
  if (10 ** k !== scale) return null;
  const digits = BigInt(intDigits + frac);
  const shift = k - frac.length;
  let str;
  if (shift >= 0) {
    str = (digits * 10n ** BigInt(shift)).toString();
  } else {
    const d = 10n ** BigInt(-shift);
    const q = digits / d;
    const r = digits % d;
    str = r === 0n ? q.toString() : `${q}.${r.toString().padStart(-shift, "0").replace(/0+$/, "")}`;
  }
  if (negative && /[1-9]/.test(str)) str = "-" + str;
  return str;
}

function captionScale(caption) {
  const m = /\bin\s+(thousands|millions|billions)\b/i.exec(caption ?? "");
  if (!m) return 1;
  return { thousands: 1e3, millions: 1e6, billions: 1e9 }[m[1].toLowerCase()];
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** 열 제목 → { periodEnd: "YYYY-MM-DD"|null, durationMonths|durationWeeks } */
export function parseColumnHeader(header) {
  const dates = [...header.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)]
    .map((m) => {
      const mo = MONTHS[m[1].toLowerCase()];
      return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
    })
    .filter(Boolean);
  const h = header.toLowerCase();
  const WORDS = { three: 3, six: 6, nine: 9, twelve: 12 };
  let durationMonths = null;
  let durationWeeks = null;
  const mm = /\b(three|six|nine|twelve|\d{1,2})[\s-]+months?\b/.exec(h);
  if (mm) durationMonths = WORDS[mm[1]] ?? Number(mm[1]);
  else if (/\b(?:fiscal\s+)?years?\b/.test(h)) durationMonths = 12;
  const wk = /\b(\d{1,2})[\s-]+weeks?\b/.exec(h);
  if (wk) durationWeeks = Number(wk[1]);
  return { periodEnd: dates.at(-1) ?? null, durationMonths, durationWeeks };
}

// ───────── 본 검증 ─────────
/**
 * @param {any} json 모델 응답
 * @param {object} schema
 * @param {string} windowText 원문 창 평문
 * @returns {{ ok: boolean; schemaErrors: string[]; warnings: string[]; columns: any[]; cells: any[]; rejected: any[] }}
 */
export function validateExtraction(json, schema, windowText) {
  const warnings = [];
  const errs = schemaErrors(json, schema);
  if (errs.length) return { ok: false, schemaErrors: errs.slice(0, 20), warnings, columns: [], cells: [], rejected: [] };

  const text = windowText;
  const ntext = norm(text);

  if (!ntext.includes(norm(json.tableTitle))) warnings.push(`표 제목이 원문 창에 없음: "${json.tableTitle}"`);
  const capScale = captionScale(json.unitCaption);
  if (json.unitCaption && !ntext.includes(norm(json.unitCaption))) {
    warnings.push(`단위 문구가 원문 창에 그대로 없음: "${json.unitCaption}"`);
  }

  // 열
  const columns = json.columns.map((c) => {
    const p = parseColumnHeader(c.header);
    const problems = [];
    if (!p.periodEnd) problems.push("기간 말일 파싱 실패");
    else {
      const dateText = /\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/g;
      const printedDates = c.header.match(dateText) ?? [];
      for (const d of printedDates) {
        if (!ntext.includes(norm(d)) && !ntext.includes(norm(d.replace(",", "")))) {
          problems.push(`날짜 "${d}" 가 원문 창에 없음`);
        }
      }
    }
    if (p.durationMonths == null && p.durationWeeks == null) problems.push("기간 길이 파싱 실패");
    if (problems.length) warnings.push(`열 ${c.columnIndex} "${c.header}": ${problems.join(", ")}`);
    return { ...c, ...p, problems };
  });
  const colByIdx = new Map(columns.map((c) => [c.columnIndex, c]));

  const cells = [];
  const rejected = [];
  const occ = new Map();
  for (const row of json.rows) {
    const baseKey = `${row.sectionLabel}|${row.label}`;
    const n = (occ.get(baseKey) ?? 0) + 1;
    occ.set(baseKey, n);
    const rowKey = n > 1 ? `${baseKey}#${n}` : baseKey;
    if (row.label && !ntext.includes(norm(row.label).replace(/:$/, ""))) {
      warnings.push(`행 제목이 원문 창에 그대로 없음: "${row.label}"`);
    }
    const seenCols = new Set();
    for (const cell of row.cells) {
      const reasons = [];
      const col = colByIdx.get(cell.columnIndex);
      if (!col) reasons.push(`없는 열 번호 ${cell.columnIndex}`);
      if (seenCols.has(cell.columnIndex)) reasons.push("같은 행에 같은 열이 두 번");
      seenCols.add(cell.columnIndex);

      const printed = cell.printed.trim();
      let value = null;
      let nil = false;
      if (DASHES.has(printed)) {
        nil = true;
        if (cell.number !== null && cell.number !== 0) reasons.push("대시인데 number 가 값");
      } else {
        const parsed = parsePrinted(printed);
        if (!parsed) reasons.push(`숫자 형식이 아님: "${printed}"`);
        else {
          const bare = printed.replace(/^-/, "");
          // 2) 환각 차단 — 숫자 문자열이 창에 독립 토큰으로 있어야 한다
          const tokenRe = new RegExp(`(?<![\\d.,])${escapeRe(bare)}(?![\\d]|,\\d|\\.\\d)`, "g");
          const hits = [...text.matchAll(tokenRe)];
          if (!hits.length) reasons.push(`원문 창에 "${bare}" 없음(환각 의심)`);
          else {
            // 3) 부호 — 괄호로 둘러싸인 출현이 있는지
            const inParens = hits.some((h) => {
              const before = text.slice(Math.max(0, h.index - 4), h.index);
              const after = text.slice(h.index + bare.length, h.index + bare.length + 4);
              return /\(\s*\$?\s*$/.test(before) || /^\s*%?\s*\)/.test(after) || /-\s*$/.test(before);
            });
            const plain = hits.some((h) => {
              const before = text.slice(Math.max(0, h.index - 4), h.index);
              const after = text.slice(h.index + bare.length, h.index + bare.length + 4);
              return !/\(\s*\$?\s*$/.test(before) && !/^\s*%?\s*\)/.test(after);
            });
            if (cell.negative && !inParens) reasons.push("음수로 표시했지만 원문에 괄호·마이너스 출현 없음");
            if (!cell.negative && !plain) reasons.push("양수로 표시했지만 원문에는 괄호 출현만 있음");
          }
          const magnitude = Number(parsed.intDigits + (parsed.frac ? "." + parsed.frac : ""));
          const expected = cell.negative ? -magnitude : magnitude;
          if (cell.number === null || Math.abs(cell.number - expected) > 1e-9 * Math.max(1, Math.abs(expected))) {
            reasons.push(`number(${cell.number}) ≠ printed(${expected})`);
          }
          // 4) 배수 — 금액은 단위 문구에서 직접 읽은 배수와 같아야 한다
          if (cell.unitKind === "currency" && cell.scale !== capScale) {
            reasons.push(`scale ${cell.scale} ≠ 단위 문구 배수 ${capScale}`);
          }
          if (cell.unitKind === "per_share" && cell.scale !== 1) reasons.push("주당 금액인데 scale ≠ 1");
          if (cell.unitKind === "shares" && ![1, 1e3, 1e6, 1e9].includes(cell.scale)) reasons.push("주식 수 scale 이상");
          if (cell.unitKind === "shares" && cell.scale !== 1) {
            const w = { 1e3: "thousand", 1e6: "million", 1e9: "billion" }[cell.scale];
            if (!new RegExp(w, "i").test(json.unitCaption ?? "")) reasons.push(`주식 수 scale ${cell.scale} 근거가 단위 문구에 없음`);
          }
          if (!reasons.length) {
            const exact = scaleExact(parsed, cell.scale, cell.negative);
            if (exact == null) reasons.push("scale 이 10의 거듭제곱이 아님");
            else if (/^-?\d+$/.test(exact)) {
              const asNum = Number(exact);
              value = Number.isSafeInteger(asNum) ? asNum : exact;
            } else value = exact; // 주당 금액 등 소수는 문자열 그대로(정밀도 보존)
            if ((cell.unitKind === "currency" || cell.unitKind === "shares") && typeof value === "string") {
              reasons.push(`배수 적용 후 정수가 아님: ${value}`);
            }
          }
        }
      }
      const rec = {
        rowIndex: row.rowIndex,
        rowKey,
        label: row.label,
        sectionLabel: row.sectionLabel,
        isSubtotal: row.isSubtotal,
        columnIndex: cell.columnIndex,
        columnHeader: col?.header ?? null,
        periodEnd: col?.periodEnd ?? null,
        durationMonths: col?.durationMonths ?? null,
        durationWeeks: col?.durationWeeks ?? null,
        printed,
        negative: cell.negative,
        nil,
        unitKind: cell.unitKind,
        scale: cell.scale,
        value,
      };
      if (reasons.length) rejected.push({ ...rec, reasons });
      else cells.push(rec);
    }
  }
  return { ok: true, schemaErrors: [], warnings, columns, cells, rejected };
}
