import "server-only";
import { fetchText, isFetchFailure } from "../http";

/**
 * みんかぶ(minkabu.jp) 증권 애널리스트 컨센서스 — 일본 종목 전용(크롤링 예외 5건, 오너 승인 2026-10-09:
 * 개인용·적은 요청·캐시, 무료만). 공개 API 가 없어 종목 페이지 `/stock/{코드}/analyst_consensus` 의
 * 서버렌더 HTML 을 읽는다(robots.txt 는 /stock/ 허용). JSON·XHR 엔드포인트는 없다(실측 2026-10-09 —
 * 값이 전부 HTML 본문에 박혀 있음).
 *
 * - **일본 IP 에서만 열린다**: 한국 IP 는 403(실측). 운영 1호기·검증 2호기(오라클 일본)에서만 값이 나온다.
 * - **요청 빈도**: 종목당 캐시 창(12시간) 안에 1회 — Next 데이터 캐시(revalidate 12h) + 이 모듈의 메모리 캐시
 *   (애널리스트 없음 = 404 도 12시간, 일시 실패는 10분 기억해 같은 종목을 연달아 두드리지 않음).
 * - **실패는 조용히 틀린 값이 되지 않는다**: 목표주가·레이팅·내역 중 하나라도 못 읽으면 data=null + warning.
 * - 404 = 민카부에 애널리스트 예상이 없는 종목(실측 1301·2970) — 오류가 아니라 "없음".
 *
 * 화면 표시 숫자는 원값 그대로 넘기고 소수점 처리는 화면(lib/format.ts, 버림)에서만.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const CACHE_SEC = 12 * 60 * 60;
const FAIL_MEMO_MS = 10 * 60 * 1000;

/** 레이팅 — 원문(強気買い·買い·中立·売り·強気売り)을 판독 단계에서 한국어로 바꿔 내보낸다(오너 지시 2026-10-09 — 일본 종목 화면은 한국어) */
export type MinkabuRating = "적극 매수" | "매수" | "중립" | "매도" | "적극 매도";
const RATINGS: MinkabuRating[] = ["적극 매수", "매수", "중립", "매도", "적극 매도"];
const RATING_JA: Record<string, MinkabuRating> = {
  強気買い: "적극 매수",
  買い: "매수",
  中立: "중립",
  売り: "매도",
  強気売り: "적극 매도",
};
/** 業績予想 행 원문 → 한국어 */
const EST_ROW_KO: Record<string, string> = { 売上高: "매출액", 当期利益: "순이익", "1株当り利益": "EPS" };
/** 변화표·業績予想 열 원문 → 한국어 */
const COL_KO: Record<string, string> = { "3ヶ月前": "3개월 전", "1ヶ月前": "1개월 전", "1週間前": "1주 전", 最新: "최신", 会社予想: "회사 예상" };

export interface MinkabuHistoryPoint {
  key: "3m" | "1m" | "1w" | "latest";
  /** 열 이름(한국어 — 3개월 전·1개월 전·1주 전·최신) */
  label: string;
  /** 원문 열 이름(3ヶ月前·1ヶ月前·1週間前·最新) */
  labelLocal: string;
  rating: MinkabuRating | null;
  targetPrice: number | null;
}

export interface MinkabuEstimateRow {
  /** 계정명(한국어 — 매출액·순이익·EPS) */
  name: string;
  /** 원문 계정명(売上高·当期利益·1株当り利益) */
  nameLocal: string;
  /** 백만엔 또는 엔(EPS) */
  unit: "백만엔" | "엔";
  /** columns 와 같은 순서 — "---" 는 null */
  values: (number | null)[];
}

export interface MinkabuEstimates {
  /** "2027年の業績予想" 의 연도 표기(本決算이 있는 해) — 한국어("2027년") */
  title: string;
  columns: { label: string; labelLocal: string; date: string | null; source: "analyst" | "company" }[];
  rows: MinkabuEstimateRow[];
}

export interface MinkabuConsensus {
  symbol: string;
  url: string;
  /** 페이지 기준일(YYYY-MM-DD) */
  asOf: string | null;
  rating: MinkabuRating;
  /** 머리 상자의 목표주가(엔) — 본문 문장·변화표의 값은 반올림이라 1엔 다를 수 있다(7203: 3,698 vs 3,699) */
  targetPrice: number;
  breakdown: Record<MinkabuRating, number>;
  analystCount: number;
  history: MinkabuHistoryPoint[];
  estimates: MinkabuEstimates | null;
}

export interface MinkabuResult {
  data: MinkabuConsensus | null;
  /** 애널리스트 예상 없음(404) */
  noCoverage: boolean;
  warning: string | null;
  source: string;
  url: string;
}

export function minkabuUrl(symbol: string): string {
  return `https://minkabu.jp/stock/${encodeURIComponent(symbol)}/analyst_consensus`;
}

const SOURCE = "민카부(minkabu.jp)";

// ── 파서 ──

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** "3,698" → 3698, "---"·빈칸 → null, 숫자 아님 → NaN(파싱 오류) */
function num(s: string): number | null {
  const t = text(s).replace(/[円人]/g, "").trim();
  if (t === "" || /^-+$/.test(t) || t === "—") return null;
  const v = Number(t.replace(/,/g, ""));
  return Number.isFinite(v) ? v : NaN;
}

/** 원문 레이팅 → 한국어(원문이 아니면 null) */
const rating = (s: string): MinkabuRating | null => RATING_JA[s] ?? null;

const ymd = (s: string | undefined) => (s ? s.replace(/\//g, "-") : null);

/** start 이후 첫 <table>…</table> */
function tableAfter(html: string, marker: string | RegExp): string | null {
  const i = typeof marker === "string" ? html.indexOf(marker) : html.search(marker);
  if (i < 0) return null;
  const a = html.indexOf("<table", i);
  const b = html.indexOf("</table>", a);
  return a < 0 || b < 0 ? null : html.slice(a, b);
}

function rowsOf(table: string): string[] {
  return table.split(/<tr[\s>]/).slice(1);
}

function cells(row: string, tag: "td" | "th" | "td|th"): string[] {
  const re = new RegExp(`<(?:${tag})\\b[^>]*>([\\s\\S]*?)</(?:${tag})>`, "g");
  return [...row.matchAll(re)].map((m) => m[1]);
}

const HISTORY_KEYS: Record<string, MinkabuHistoryPoint["key"]> = {
  "3ヶ月前": "3m",
  "1ヶ月前": "1m",
  "1週間前": "1w",
  最新: "latest",
};

/** 파싱 실패 사유를 던진다(호출부가 warning 으로) — 테스트용으로 export */
export function parseMinkabu(html: string, symbol: string): MinkabuConsensus {
  // 머리 상자: <h2 class="wsnw">アナリスト予想<br><span class="fsm">(2026/10/09)</span></h2> … 레이팅 … <span class="fsxxl">3,698</span>
  const h = html.search(/<h2[^>]*>\s*アナリスト予想<br>/);
  if (h < 0) throw new Error("머리 상자(アナリスト予想) 없음 — 페이지 구조 변경 가능성");
  const head = html.slice(h, h + 3000);
  const asOf = ymd(head.match(/\((\d{4}\/\d{2}\/\d{2})\)/)?.[1]);
  const ratingRaw = text(head.match(/md_picksPlate[^"]*size_l[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
  const ratingKo = rating(ratingRaw);
  if (!ratingKo) throw new Error(`레이팅 판독 실패("${ratingRaw}")`);
  const target = num(head.match(/<span class="fsxxl">([\s\S]*?)<\/span>/)?.[1] ?? "");
  if (target == null || Number.isNaN(target) || target <= 0) throw new Error("목표주가 판독 실패");

  // 내역: 머리줄 th 순서대로 「N人」
  const bt = tableAfter(html, "証券アナリスト予想内訳");
  if (!bt) throw new Error("예상 내역 표 없음");
  const btRows = rowsOf(bt);
  const heads = cells(btRows[0] ?? "", "th").map(text);
  const countRow = btRows.find((r) => /<div class="bggl">/.test(r));
  const counts = countRow ? cells(countRow, "td").map(num) : [];
  if (heads.length !== 5 || counts.length !== 5 || !heads.every((h) => rating(h)) || counts.some((c) => c == null || Number.isNaN(c)))
    throw new Error(`예상 내역 판독 실패(머리 ${heads.join("/")} · 값 ${counts.join("/")})`);
  const breakdown = Object.fromEntries(RATINGS.map((r) => [r, 0])) as Record<MinkabuRating, number>;
  heads.forEach((r, i) => (breakdown[rating(r) as MinkabuRating] = counts[i] as number));
  const analystCount = RATINGS.reduce((s, r) => s + breakdown[r], 0);
  if (analystCount <= 0) throw new Error("애널리스트 수 0");

  // 변화표(선택): 3ヶ月前 / 1ヶ月前 / 1週間前 / 最新
  const history: MinkabuHistoryPoint[] = [];
  const ht = tableAfter(html, "証券アナリスト予想の変化");
  if (ht) {
    const rs = rowsOf(ht);
    const cols = cells(rs[0] ?? "", "th").map(text).slice(1);
    const ratingRow = rs.find((r) => /<th[^>]*>\s*評価\s*<\/th>/.test(r));
    const priceRow = rs.find((r) => /<th[^>]*>\s*予想株価\s*<\/th>/.test(r));
    const rv = ratingRow ? cells(ratingRow, "td").map(text) : [];
    const pv = priceRow ? cells(priceRow, "td").map(num) : [];
    cols.forEach((label, i) => {
      const key = HISTORY_KEYS[label];
      if (!key) return;
      const p = pv[i];
      history.push({
        key,
        label: COL_KO[label] ?? label,
        labelLocal: label,
        rating: rv[i] ? rating(rv[i]) : null,
        targetPrice: p == null || Number.isNaN(p) ? null : p,
      });
    });
  }

  // 業績予想(선택): 머리 2줄(証券アナリスト予想 colspan 4 + 会社予想) → 날짜 열, 이후 売上高·当期利益·1株当り利益
  let estimates: MinkabuEstimates | null = null;
  const titleM = html.match(/<h3>\s*(\d{4}年)の業績予想\s*<\/h3>/);
  const et = titleM ? tableAfter(html, titleM[0]) : null;
  if (titleM && et) {
    const rs = rowsOf(et);
    const dateRow = rs.find((r) => /3ヶ月前/.test(r) && /\(\d{4}\/\d{2}\/\d{2}\)/.test(r));
    const colCells = dateRow ? cells(dateRow, "th") : [];
    const columns = colCells.map((c, i) => {
      const label = text(c.replace(/<div[\s\S]*?<\/div>/, ""));
      return {
      label: COL_KO[label] ?? label,
      labelLocal: label,
      date: ymd(c.match(/\((\d{4}\/\d{2}\/\d{2})\)/)?.[1]),
      source: (i === colCells.length - 1 ? "company" : "analyst") as "analyst" | "company",
      };
    });
    const rows: MinkabuEstimateRow[] = [];
    for (const r of rs) {
      const th = cells(r, "th").map(text);
      if (th.length !== 1 || !/^(売上高|当期利益|1株当り利益)$/.test(th[0])) continue;
      const vals = cells(r, "td").map(num);
      if (vals.length !== columns.length || vals.some((v) => Number.isNaN(v))) continue;
      rows.push({ name: EST_ROW_KO[th[0]], nameLocal: th[0], unit: th[0] === "1株当り利益" ? "엔" : "백만엔", values: vals as (number | null)[] });
    }
    if (columns.length === 5 && rows.length) estimates = { title: titleM[1].replace("年", "년"), columns, rows };
  }

  return { symbol, url: minkabuUrl(symbol), asOf, rating: ratingKo, targetPrice: target, breakdown, analystCount, history, estimates };
}

// ── 조회(캐시) ──

const memo = new Map<string, { at: number; ttl: number; result: MinkabuResult }>();
const inflight = new Map<string, Promise<MinkabuResult>>();

async function load(symbol: string): Promise<MinkabuResult> {
  const url = minkabuUrl(symbol);
  const base = { source: SOURCE, url };
  const opts = {
    headers: { "user-agent": UA, accept: "text/html", "accept-language": "ja,en;q=0.8" },
    revalidate: CACHE_SEC,
    timeoutMs: 10_000,
  };
  let html: string;
  try {
    html = await fetchText(url, opts);
  } catch (e) {
    if (isFetchFailure(e) && e.opts.status === 404) return { ...base, data: null, noCoverage: true, warning: null };
    const st = isFetchFailure(e) ? e.opts.status : undefined;
    return {
      ...base,
      data: null,
      noCoverage: false,
      warning: `민카부 조회 실패${st ? ` (HTTP ${st}${st === 403 ? " — 일본 IP 에서만 열림" : ""})` : ""}`,
    };
  }
  try {
    return { ...base, data: parseMinkabu(html, symbol), noCoverage: false, warning: null };
  } catch (e1) {
    // 데이터 캐시에 남은 이상한 본문일 수 있어 캐시 없이 한 번만 더
    try {
      const fresh = await fetchText(url, { ...opts, noStore: true });
      return { ...base, data: parseMinkabu(fresh, symbol), noCoverage: false, warning: null };
    } catch (e2) {
      const msg = (e2 instanceof Error ? e2.message : String(e2)) || (e1 instanceof Error ? e1.message : String(e1));
      console.warn(`[minkabu] ${symbol} 판독 실패: ${msg}`);
      return { ...base, data: null, noCoverage: false, warning: `민카부 판독 실패 — ${msg}` };
    }
  }
}

/** 일본 종목 코드(4자리 또는 285A 형식) → 민카부 컨센서스. 절대 throw 하지 않는다. */
export async function getMinkabuConsensus(symbol: string): Promise<MinkabuResult> {
  const sym = symbol.trim().toUpperCase();
  if (!/^[0-9][0-9A-Z]{3}$/.test(sym)) {
    return { data: null, noCoverage: false, warning: "일본 종목 코드 형식 아님", source: SOURCE, url: minkabuUrl(sym) };
  }
  const hit = memo.get(sym);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;
  const running = inflight.get(sym);
  if (running) return running;
  const p = load(sym)
    .then((result) => {
      memo.set(sym, { at: Date.now(), ttl: result.warning ? FAIL_MEMO_MS : CACHE_SEC * 1000, result });
      if (memo.size > 3000) for (const [k, v] of memo) if (Date.now() - v.at >= v.ttl) memo.delete(k);
      return result;
    })
    .finally(() => inflight.delete(sym));
  inflight.set(sym, p);
  return p;
}
