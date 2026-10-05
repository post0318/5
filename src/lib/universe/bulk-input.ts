/**
 * 유니버스 일괄 업로드 — 입력(붙여넣기·CSV·엑셀) → 행 목록 (오너 지시 2026-10-05).
 *
 * 여기서는 **글자만 나눈다** — 종목 해석(코드 ↔ 이름, 시장 판별)은
 * `resolve.ts`(서버 전용)가 한다. 외부 호출이 없는 순수 함수라 따로 시험할 수 있다.
 *
 * 입력 형태:
 *  - 표(엑셀 .xlsx · .csv · 엑셀에서 복사한 탭 구분 붙여넣기): 첫 행이 헤더면
 *    열 이름(시장/코드/종목명/그룹/태그/메모, 한글·영문)으로 읽는다. 헤더가 없으면
 *    첫 열 = 코드 또는 종목명, 둘째 열 = 종목명(참고), 셋째 열 = 그룹. 첫 열이
 *    시장(kr/us/jp·한국/미국/일본)이면 예전 형식 `시장,코드,이름,그룹`.
 *  - 목록 붙여넣기: "삼성전자, 엔비디아, SK하이닉스" 처럼 쉼표·세미콜론·줄바꿈으로
 *    나눈 낱낱이 한 종목(코드 또는 이름).
 */
import { unzipSync } from "fflate";
import type { MarketId } from "@/lib/markets/types";

export const BULK_MAX_ROWS = 1000;
export const BULK_MAX_FILE_BYTES = 1024 * 1024;
/** 압축을 푼 엑셀 XML 합계 상한 — 작은 파일로 메모리를 터뜨리는 압축 폭탄 방지 */
const XLSX_MAX_UNZIPPED_BYTES = 30 * 1024 * 1024;

/** 한 행 — 해석 전 입력값 */
export interface BulkEntry {
  /** 원본 행 번호(1부터, 헤더 포함 파일 기준) */
  line: number;
  /** 화면 표시용 원문 */
  raw: string;
  /** 시장 열 값(해석된 것). 없으면 기본 시장/자동 판별 */
  market?: MarketId;
  /** 시장 열에 값이 있는데 알아볼 수 없을 때 원문 */
  badMarket?: string;
  code?: string;
  name?: string;
  groupName?: string;
  tags?: string[];
  note?: string;
}

export interface BulkInputResult {
  entries: BulkEntry[];
  /** 형식 안내(헤더 인식 결과·행 수 초과 등) */
  notices: string[];
}

// ---- 시장 값 -------------------------------------------------------------

const MARKET_WORDS: Record<string, MarketId> = {
  kr: "kr", kor: "kr", korea: "kr", 한국: "kr", 국내: "kr", krx: "kr",
  kospi: "kr", kosdaq: "kr", 코스피: "kr", 코스닥: "kr", 유가증권: "kr",
  us: "us", usa: "us", 미국: "us", nasdaq: "us", nyse: "us", amex: "us",
  나스닥: "us", 뉴욕: "us", 해외: "us",
  jp: "jp", jpn: "jp", japan: "jp", 일본: "jp", tse: "jp", jpx: "jp", 도쿄: "jp", 東証: "jp",
};

/** 시장 열 값 → MarketId. 모르면 undefined */
export function parseMarketWord(v: string): MarketId | undefined {
  const k = v.trim().toLowerCase().replace(/\s+/g, "");
  return MARKET_WORDS[k];
}

// ---- 헤더 ----------------------------------------------------------------

type Field = "market" | "code" | "name" | "group" | "tags" | "note";

const HEADER_WORDS: Record<Field, string[]> = {
  market: ["시장", "market", "국가", "country", "거래소", "exchange"],
  code: ["코드", "종목코드", "단축코드", "티커", "ticker", "symbol", "code", "심볼", "종목번호"],
  name: ["종목명", "이름", "종목", "회사명", "기업명", "name", "company", "회사", "stock"],
  group: ["그룹", "group", "그룹명", "분류", "category", "섹터", "sector"],
  tags: ["태그", "tag", "tags"],
  note: ["메모", "note", "notes", "memo", "비고", "comment"],
};

function headerField(cell: string): Field | undefined {
  const k = cell.trim().toLowerCase().replace(/[\s_()*]/g, "");
  if (!k) return undefined;
  for (const f of Object.keys(HEADER_WORDS) as Field[]) {
    if (HEADER_WORDS[f].includes(k)) return f;
  }
  return undefined;
}

/** 첫 행이 헤더인가 — 코드나 종목명 열 이름이 하나라도 있고, 알아본 칸이 채워진 칸의 절반 이상 */
function detectHeader(row: string[]): Map<Field, number> | null {
  const cols = new Map<Field, number>();
  let filled = 0;
  row.forEach((cell, i) => {
    if (!cell.trim()) return;
    filled += 1;
    const f = headerField(cell);
    if (f && !cols.has(f)) cols.set(f, i);
  });
  if (!cols.has("code") && !cols.has("name")) return null;
  if (cols.size * 2 < filled) return null;
  return cols;
}

function splitTags(v: string): string[] {
  return v
    .split(/[,;|/]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((t) => t.slice(0, 40));
}

const clip = (v: string | undefined, n: number) => {
  const t = v?.trim();
  return t ? t.slice(0, n) : undefined;
};

/** 표(행 × 칸) → 입력 행. firstLine = 첫 행의 원본 행 번호 */
export function tableToEntries(rows: string[][], firstLine = 1): BulkInputResult {
  const notices: string[] = [];
  const entries: BulkEntry[] = [];
  let start = 0;
  const header = rows.length > 0 ? detectHeader(rows[0]) : null;
  if (header) {
    start = 1;
    const names: Record<Field, string> = {
      market: "시장", code: "코드", name: "종목명", group: "그룹", tags: "태그", note: "메모",
    };
    notices.push(
      `첫 행을 헤더로 읽었습니다: ${[...header.keys()].map((f) => names[f]).join(" · ")}`,
    );
  }

  for (let r = start; r < rows.length; r++) {
    const cells = rows[r].map((c) => c.trim());
    if (cells.every((c) => !c)) continue;
    if (cells[0]?.startsWith("#")) continue; // 주석 행
    const line = firstLine + r;
    const raw = cells.filter(Boolean).join(" · ");
    const e: BulkEntry = { line, raw };

    if (header) {
      const at = (f: Field) => {
        const i = header.get(f);
        return i == null ? undefined : cells[i] || undefined;
      };
      const m = at("market");
      if (m) {
        e.market = parseMarketWord(m);
        if (!e.market) e.badMarket = m;
      }
      e.code = clip(at("code"), 20);
      e.name = clip(at("name"), 120);
      e.groupName = clip(at("group"), 60);
      const t = at("tags");
      if (t) e.tags = splitTags(t);
      e.note = clip(at("note"), 500);
    } else {
      // 헤더 없음 — 첫 칸이 시장이면 예전 형식(시장,코드,이름,그룹)
      let c = cells;
      const m = parseMarketWord(c[0] ?? "");
      if (m && c.length >= 2) {
        e.market = m;
        c = c.slice(1);
      }
      // 첫 칸 = 코드 또는 종목명(해석 단계가 판별), 둘째 = 종목명(참고), 셋째 = 그룹
      // (첫 칸이 이름이고 둘째 칸이 코드면 — "삼성전자,005930" — 순서를 바꿔 읽는다)
      const first = c[0] ?? "";
      if (looksLikeCode(first)) {
        e.code = clip(first, 20);
        e.name = clip(c[1], 120);
      } else if (c[1] && looksLikeCode(c[1])) {
        e.name = clip(first, 120);
        e.code = clip(c[1], 20);
      } else {
        e.name = clip(first, 120);
      }
      e.groupName = clip(c[2], 60);
    }
    if (!e.code && !e.name) continue;
    entries.push(e);
  }

  if (entries.length > BULK_MAX_ROWS) {
    notices.push(`행이 ${entries.length}개라 앞의 ${BULK_MAX_ROWS}개만 읽었습니다.`);
    entries.length = BULK_MAX_ROWS;
  }
  return { entries, notices };
}

/**
 * 코드처럼 보이는가 — 숫자(한국 6자리·일본 4자리·엑셀이 앞 0을 지운 숫자) 또는
 * 영문 티커 꼴(공백 없는 영대문자·숫자 10자 이내). 소문자 한 단어("apple")는 이름으로 본다.
 */
export function looksLikeCode(v: string): boolean {
  const s = v.trim();
  if (/^A?\d{1,6}$/.test(s)) return true;
  return /^[A-Z][A-Z0-9]{0,5}([.\-/][A-Z0-9]{1,3})?$/.test(s);
}

// ---- 붙여넣기 ------------------------------------------------------------

/**
 * 붙여넣은 글 → 입력 행.
 *  - 탭이 있으면 엑셀에서 복사한 표로 본다.
 *  - 첫 줄이 헤더이거나 줄마다 첫 칸이 시장이면 쉼표 구분 표.
 *  - 그 밖에는 쉼표·세미콜론·줄바꿈으로 나눈 낱낱이 한 종목.
 */
export function parsePastedText(text: string): BulkInputResult {
  const body = text.replace(/^﻿/, "");
  const lines = body.split(/\r?\n/);
  if (lines.some((l) => l.includes("\t"))) {
    const rows = lines.map((l) => l.split("\t"));
    return tableToEntries(rows);
  }
  const csvRows = parseCsv(body);
  const nonEmpty = csvRows.filter((r) => r.some((c) => c.trim()));
  if (nonEmpty.length > 0) {
    const headerish = detectHeader(nonEmpty[0]) != null;
    const marketFirst = nonEmpty.every(
      (r) => r.length >= 2 && (parseMarketWord(r[0]) != null || r[0].trim().startsWith("#")),
    );
    if (headerish || marketFirst) return tableToEntries(csvRows);
  }

  // 낱낱 목록
  const entries: BulkEntry[] = [];
  lines.forEach((l, i) => {
    if (l.trim().startsWith("#")) return;
    for (const tok of l.split(/[,;，、]/)) {
      const t = tok.trim();
      if (!t) continue;
      const e: BulkEntry = { line: i + 1, raw: t };
      if (looksLikeCode(t)) e.code = clip(t, 20);
      else e.name = clip(t, 120);
      entries.push(e);
    }
  });
  const notices: string[] = [];
  if (entries.length > BULK_MAX_ROWS) {
    notices.push(`종목이 ${entries.length}개라 앞의 ${BULK_MAX_ROWS}개만 읽었습니다.`);
    entries.length = BULK_MAX_ROWS;
  }
  return { entries, notices };
}

// ---- CSV -----------------------------------------------------------------

/** 따옴표 지원 CSV. 구분자는 첫 줄에서 쉼표·세미콜론·탭 중 많은 것 */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  let delim = ",";
  let best = 0;
  for (const d of [",", ";", "\t"]) {
    const n = firstLine.split(d).length - 1;
    if (n > best) [delim, best] = [d, n];
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQ) {
      if (c === '"' && body[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === "") {
      inQ = true;
      cur = "";
    } else if (c === delim) {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** CSV 바이트 → 글자. UTF-8 이 아니면 한국 엑셀 기본 저장 인코딩(CP949)으로 */
export function decodeCsvBytes(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

// ---- XLSX ----------------------------------------------------------------

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, g: string) => {
    const k = g.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

/** <si>·<is> 안의 글자 — 서식 조각(<r><t>)을 잇고 일본어 읽기(<rPh>)는 뺀다 */
function richText(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * .xlsx(첫 번째 시트) → 행 × 칸. 새 의존성 없이 이미 쓰는 fflate 로 압축을 풀고
 * 시트 XML 을 직접 읽는다 — 값·공유 문자열·인라인 문자열만(수식은 저장된 결과값).
 */
export function parseXlsx(buf: Uint8Array): string[][] {
  let declared = 0;
  const want = (name: string) =>
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    /^xl\/worksheets\/[^/]+\.xml$/.test(name);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, {
      filter: (f) => {
        if (!want(f.name)) return false;
        declared += f.originalSize;
        if (declared > XLSX_MAX_UNZIPPED_BYTES) throw new Error("too large");
        return true;
      },
    });
  } catch (e) {
    if ((e as Error).message === "too large") throw new Error("엑셀 내용이 너무 큽니다(압축 해제 30MB 초과)");
    throw new Error("엑셀(.xlsx) 파일을 읽을 수 없습니다");
  }
  const text = (n: string) => (files[n] ? new TextDecoder("utf-8").decode(files[n]) : "");

  // 첫 번째 시트 경로: workbook.xml 의 첫 <sheet r:id> → rels 의 Target
  let sheetPath = "";
  const wb = text("xl/workbook.xml");
  const firstSheet = /<sheet\b[^>]*>/.exec(wb)?.[0];
  const rid = firstSheet ? attr(firstSheet, "r:id") : undefined;
  if (rid) {
    const rels = text("xl/_rels/workbook.xml.rels");
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(m[0], "Id") !== rid) continue;
      const target = attr(m[0], "Target") ?? "";
      sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    }
  }
  if (!files[sheetPath]) {
    sheetPath = Object.keys(files).filter((n) => n.startsWith("xl/worksheets/")).sort()[0] ?? "";
  }
  if (!sheetPath) throw new Error("엑셀 파일에 시트가 없습니다");

  const shared: string[] = [];
  for (const m of text("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(richText(m[1]));
  }

  const rows: string[][] = [];
  const sheet = text(sheetPath);
  let lastRow = 0;
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rNum = Number(attr(rm[1], "r")) || lastRow + 1;
    // 빈 행(행 번호 건너뜀)은 빈 배열로 채워 행 번호를 엑셀과 맞춘다
    while (rows.length < rNum - 1) rows.push([]);
    lastRow = rNum;
    const cells: string[] = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], "r");
      const idx = ref ? colIndex(ref) : cells.length;
      const t = attr(cm[1], "t");
      const inner = cm[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = "";
      if (t === "s") val = v != null ? (shared[Number(v)] ?? "") : "";
      else if (t === "inlineStr") val = richText(inner);
      else if (t === "b") val = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else if (t === "e") val = "";
      else val = v != null ? decodeXml(v) : "";
      while (cells.length < idx) cells.push("");
      cells[idx] = val;
    }
    rows.push(cells);
    if (rows.length > BULK_MAX_ROWS + 50) break; // 상한 + 헤더·빈 줄 여유
  }
  return rows;
}

/** 파일 → 입력 행 */
export function parseBulkFile(fileName: string, buf: Uint8Array): BulkInputResult {
  if (buf.byteLength > BULK_MAX_FILE_BYTES) {
    throw new Error("파일이 너무 큽니다(1MB 이하)");
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return tableToEntries(parseXlsx(buf));
  if (lower.endsWith(".xls")) {
    throw new Error("옛 엑셀 형식(.xls)은 읽지 못합니다 — .xlsx 또는 .csv 로 저장해 올려 주세요");
  }
  if (lower.endsWith(".csv")) return tableToEntries(parseCsv(decodeCsvBytes(buf)));
  if (lower.endsWith(".txt")) return parsePastedText(decodeCsvBytes(buf));
  throw new Error("지원하는 파일은 .xlsx · .csv · .txt 입니다");
}
