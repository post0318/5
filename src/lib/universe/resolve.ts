import "server-only";
import {
  findCorpsByExactName,
  normalizeCorpName,
  resolveCorpCode,
  searchCorps,
} from "@/lib/markets/kr/corpcode";
import { fetchJson } from "@/lib/markets/http";
import type { MarketId } from "@/lib/markets/types";
import type { BulkEntry } from "./bulk-input";

/**
 * 유니버스 일괄 업로드 — 입력 행 → 종목 해석 (오너 지시 2026-10-05).
 *
 * 코드를 주면 공식 종목명을, 이름을 주면 코드·시장을 찾는다. 이미 앱이 쓰는 목록만
 * 쓴다: 한국 = DART 상장사 표(corpcodes.json), 미국 = SEC 티커 목록
 * (company_tickers.json), 일본 = EDINET 코드 목록. 한글 이름으로 미국·일본 종목을
 * 찾을 때(예: "엔비디아")만 종목뉴스가 이미 쓰는 네이버 증권 자동완성
 * (ac.stock.naver.com)으로 코드를 얻고, 그 코드도 위 목록에서 다시 확인한다
 * (목록에 없는 코드는 버린다). 저장하는 이름은 항상 위 목록의 공식 이름이다.
 *
 * 애매하면 확정하지 않는다 — 후보가 둘 이상이거나 추측(4자리 숫자 등)이면
 * "후보" 상태로 돌려 화면에서 사람이 고른다.
 */

export interface BulkCandidate {
  market: MarketId;
  symbol: string;
  /** 공식 종목명(DART·SEC·EDINET 목록) */
  name: string;
  yahooSymbol?: string | null;
  /** 어디서 찾았는지(화면 표시) */
  via?: string;
}

export type BulkRowStatus = "confirmed" | "candidates" | "notFound";

export interface BulkResolvedRow {
  line: number;
  raw: string;
  input: { market?: MarketId; code?: string; name?: string };
  groupName?: string;
  tags?: string[];
  note?: string;
  status: BulkRowStatus;
  match?: BulkCandidate;
  candidates?: BulkCandidate[];
  /** 못 찾은 사유 또는 후보 상태의 이유 */
  reason?: string;
  /** 확정됐지만 알려둘 것(앞자리 0 보정·입력 이름과 다름 등) */
  notes?: string[];
}

const MAX_CANDIDATES = 10;
/** 네이버 자동완성 동시 요청 수 */
const NAVER_CONCURRENCY = 4;

const HANGUL = /[가-힣ㄱ-ㅎ]/;
const KANA_KANJI = /[぀-ヿ一-鿿]/;

// ---- 목록 접근 -----------------------------------------------------------

interface Lists {
  edgar: () => Promise<ReadonlyMap<string, { ticker: string; title: string }>>;
  /** 정규화한 미국 회사명 → 행들(한 번만 만든다 — 1,000행 × 1만 회사 반복 방지) */
  edgarByName: () => Promise<Map<string, { ticker: string; title: string }[]>>;
  edinet: () => Promise<{
    byTicker: Map<string, { ticker: string; name: string }>;
    all: { ticker: string; name: string; nameEng: string }[];
  }>;
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load());
}

function makeLists(): Lists {
  const edgar = memo(async () => (await import("@/lib/markets/us/edgar")).getEdgarTickerMap());
  return {
    edgar,
    edgarByName: memo(async () => {
      const out = new Map<string, { ticker: string; title: string }[]>();
      for (const row of (await edgar()).values()) {
        const k = normalizeUsName(row.title);
        const arr = out.get(k);
        if (arr) arr.push(row);
        else out.set(k, [row]);
      }
      return out;
    }),
    edinet: memo(async () => (await import("@/lib/markets/jp/edinetcode")).getEdinetCodeIndex()),
  };
}

function krByCode(code: string): BulkCandidate | null {
  try {
    const e = resolveCorpCode("", code);
    return { market: "kr", symbol: e.stockCode, name: e.corpName };
  } catch {
    return null;
  }
}

async function usByTicker(lists: Lists, t: string): Promise<BulkCandidate | null> {
  const map = await lists.edgar();
  const s = t.trim().toUpperCase();
  const row = map.get(s) ?? map.get(s.replace(/[./]/g, "-"));
  return row ? { market: "us", symbol: row.ticker.toUpperCase(), name: row.title } : null;
}

async function jpByTicker(lists: Lists, t: string): Promise<BulkCandidate | null> {
  const idx = await lists.edinet();
  const e = idx.byTicker.get(t.trim().toUpperCase().replace(/\.(T|JP)$/i, ""));
  return e ? { market: "jp", symbol: e.ticker, name: e.name, yahooSymbol: `${e.ticker}.T` } : null;
}

/** 저장 직전 재확인용 — 시장·코드로 공식 종목명. 없으면 null */
export async function lookupOfficial(
  market: MarketId,
  symbol: string,
  lists: Lists = makeLists(),
): Promise<BulkCandidate | null> {
  if (market === "kr") return /^\d{6}$/.test(symbol) ? krByCode(symbol) : null;
  if (market === "us") return usByTicker(lists, symbol);
  return jpByTicker(lists, symbol);
}

export { makeLists as makeBulkLists };

// ---- 이름 정규화 ---------------------------------------------------------

const US_SUFFIX = /\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|sa|ag|nv|lp|llc)$/;

/** 미국 회사명 비교용 — 구두점·"/DE/"·회사 형태 접미어를 걷어낸다(Apple Inc. = apple) */
function normalizeUsName(s: string): string {
  let t = s
    .toLowerCase()
    .replace(/\/[a-z]{2}\/?$/, "") // EDGAR "/DE/" 등 설립지 표기
    .replace(/[.,'’&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
  for (let i = 0; i < 3; i++) t = t.replace(US_SUFFIX, "").trim();
  return t;
}

const normalizeLoose = (s: string) =>
  s.toLowerCase().replaceAll("(주)", "").replaceAll("株式会社", "").replace(/[\s.,()㈜·]/g, "");

// ---- 네이버 자동완성(종목뉴스와 같은 엔드포인트) -------------------------

interface NaverAcItem {
  code?: string;
  name?: string;
  nationCode?: string;
  category?: string;
}

const NAVER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

async function naverAc(q: string): Promise<NaverAcItem[] | null> {
  try {
    const res = await fetchJson<{ items?: NaverAcItem[] }>(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`,
      { headers: { "user-agent": NAVER_UA }, revalidate: 86400, timeoutMs: 8_000 },
    );
    return (res.items ?? []).filter((i) => !i.category || i.category === "stock");
  } catch {
    return null;
  }
}

const NATION: Record<string, MarketId> = { KOR: "kr", USA: "us", JPN: "jp" };

/** 동시 실행 제한 */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

// ---- 해석 ----------------------------------------------------------------

interface Found {
  cands: BulkCandidate[];
  /** 하나뿐이어도 사람이 확인해야 하는 추측 */
  guess?: boolean;
  reason?: string;
  notes?: string[];
}

const candKey = (c: BulkCandidate) => `${c.market}:${c.symbol}`;

function uniq(cands: BulkCandidate[]): BulkCandidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => {
    const k = `${c.market}:${c.symbol}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function byCode(lists: Lists, rawCode: string, market?: MarketId): Promise<Found> {
  let s = rawCode.trim().toUpperCase();
  if (/^A\d{6}$/.test(s)) s = s.slice(1); // 증권사 HTS 표기 A005930
  const notes: string[] = [];

  if (/^\d+$/.test(s)) {
    if (market === "us") return { cands: [], reason: "미국 종목코드는 영문 티커입니다" };
    if (s.length > 6) return { cands: [], reason: "숫자 코드가 6자리를 넘습니다" };
    const cands: BulkCandidate[] = [];
    if (market !== "jp") {
      const kr = krByCode(s.padStart(6, "0"));
      if (kr) {
        cands.push({ ...kr, via: "DART 상장사" });
        if (s.length < 6) notes.push(`앞자리 0 보정: ${s} → ${kr.symbol}`);
      }
    }
    if (s.length === 4 && market !== "kr") {
      try {
        const jp = await jpByTicker(lists, s);
        if (jp) cands.push({ ...jp, via: "EDINET" });
      } catch {
        if (market === "jp") return { cands: [], reason: "일본 종목 목록(EDINET)을 불러오지 못했습니다" };
        notes.push("일본 종목 목록(EDINET)을 불러오지 못해 일본 코드는 확인하지 못했습니다");
      }
    }
    if (cands.length === 0) {
      return {
        cands,
        reason:
          market === "jp"
            ? "EDINET 상장사 목록에 없는 코드"
            : market === "kr"
              ? "DART 상장사 목록에 없는 종목코드(ETF·리츠 등은 개별 등록에서 검색)"
              : "한국·일본 상장사 목록에 없는 코드",
      };
    }
    // 시장을 정하지 않은 4자리 숫자 = 일본 코드이거나 엑셀이 앞 0을 지운 한국 코드
    const guess = s.length === 4 && market == null;
    if (guess) notes.push("4자리 숫자는 일본 코드이거나 앞자리 0이 빠진 한국 코드일 수 있습니다");
    return { cands, guess, notes };
  }

  // 영문 티커 꼴
  const cands: BulkCandidate[] = [];
  if (market == null || market === "us") {
    try {
      const us = await usByTicker(lists, s);
      if (us) cands.push({ ...us, via: "SEC 티커" });
    } catch {
      return { cands: [], reason: "미국 티커 목록(SEC)을 불러오지 못했습니다" };
    }
  }
  if (market === "jp") {
    try {
      const jp = await jpByTicker(lists, s);
      if (jp) cands.push({ ...jp, via: "EDINET" });
    } catch {
      return { cands: [], reason: "일본 종목 목록(EDINET)을 불러오지 못했습니다" };
    }
  }
  // NAVER·LG·SK 처럼 한국 상장사 이름이 영문 대문자인 경우 — 미국 티커와 겹치면 후보로
  if (market == null || market === "kr") {
    for (const e of findCorpsByExactName(s)) {
      cands.push({ market: "kr", symbol: e.stockCode, name: e.corpName, via: "DART 상장사(이름)" });
    }
  }
  return { cands: uniq(cands), notes };
}

async function byName(
  lists: Lists,
  name: string,
  market: MarketId | undefined,
  naverLimit: ReturnType<typeof limiter>,
): Promise<Found> {
  const n = name.trim();
  const hangul = HANGUL.test(n);
  const japanese = !hangul && KANA_KANJI.test(n);
  const notes: string[] = [];

  // 1) 목록의 정확한 이름
  if (market === "kr" || (market == null && hangul)) {
    const exact = findCorpsByExactName(n);
    if (exact.length === 1) {
      const e = exact[0];
      return { cands: [{ market: "kr", symbol: e.stockCode, name: e.corpName, via: "DART 상장사" }] };
    }
  }
  if (market === "us" || (market == null && !hangul && !japanese)) {
    try {
      const rows = (await lists.edgarByName()).get(normalizeUsName(n)) ?? [];
      const exact: BulkCandidate[] = rows.map((row) => ({
        market: "us" as const,
        symbol: row.ticker.toUpperCase(),
        name: row.title,
        via: "SEC 회사명",
      }));
      // 한 회사의 여러 티커(GOOGL·GOOG 등)도 정확 일치가 둘 이상이면 고르게 한다
      if (exact.length >= 1) {
        return exact.length === 1
          ? { cands: exact }
          : { cands: exact.slice(0, MAX_CANDIDATES), reason: "같은 이름의 종목이 여럿입니다" };
      }
    } catch {
      if (market === "us") return { cands: [], reason: "미국 티커 목록(SEC)을 불러오지 못했습니다" };
    }
  }
  if (market === "jp" || (market == null && japanese)) {
    try {
      const idx = await lists.edinet();
      const key = normalizeLoose(n);
      const exact = idx.all.filter(
        (e) => e.ticker && (normalizeLoose(e.name) === key || normalizeLoose(e.nameEng) === key),
      );
      if (exact.length === 1) {
        const e = exact[0];
        return { cands: [{ market: "jp", symbol: e.ticker, name: e.name, yahooSymbol: `${e.ticker}.T`, via: "EDINET" }] };
      }
    } catch {
      if (market === "jp") return { cands: [], reason: "일본 종목 목록(EDINET)을 불러오지 못했습니다" };
    }
  }

  // 2) 네이버 증권 자동완성 — 한글 이름의 해외 종목(엔비디아) · 약칭(현대차)
  const fuzzy: BulkCandidate[] = [];
  const items = await naverLimit(() => naverAc(n));
  if (items == null) notes.push("네이버 종목 검색에 실패해 목록 검색 결과만 보여줍니다");
  const exactNaver: BulkCandidate[] = [];
  for (const it of items ?? []) {
    const m = it.nationCode ? NATION[it.nationCode] : undefined;
    if (!m || !it.code) continue;
    if (market && m !== market) continue;
    let c: BulkCandidate | null = null;
    try {
      c = await lookupOfficial(m, it.code, lists);
    } catch {
      c = null; // 목록을 못 불러오면 확인 불가 — 후보에서 뺀다
    }
    if (!c) continue;
    c = { ...c, via: `네이버 증권 검색(${it.name ?? it.code})` };
    if (it.name && normalizeLoose(it.name) === normalizeLoose(n)) exactNaver.push(c);
    else fuzzy.push(c);
  }
  const exactU = uniq(exactNaver);
  if (exactU.length === 1) return { cands: exactU, notes };

  // 3) 목록 부분 일치 — 후보로만
  if (market === "kr" || (market == null && (hangul || !japanese))) {
    for (const e of searchCorps("", n)) {
      fuzzy.push({ market: "kr", symbol: e.stockCode, name: e.corpName, via: "DART 상장사" });
    }
  }
  if (market === "us" || (market == null && !hangul && !japanese)) {
    try {
      const { searchEdgarTickers } = await import("@/lib/markets/us/edgar");
      for (const r of await searchEdgarTickers(n)) {
        fuzzy.push({ market: "us", symbol: r.ticker.toUpperCase(), name: r.title, via: "SEC 회사명" });
      }
    } catch {
      /* 위에서 이미 실패를 알렸거나 자동 판별 중 — 다른 시장 후보로 진행 */
    }
  }
  if (market === "jp" || (market == null && japanese)) {
    try {
      const { searchEdinet } = await import("@/lib/markets/jp/edinetcode");
      for (const e of await searchEdinet(n)) {
        fuzzy.push({ market: "jp", symbol: e.ticker, name: e.name, yahooSymbol: `${e.ticker}.T`, via: "EDINET" });
      }
    } catch {
      /* 동일 */
    }
  }
  const cands = uniq([...exactU, ...fuzzy]).slice(0, MAX_CANDIDATES);
  if (cands.length === 0) return { cands, reason: "일치하는 상장 종목을 찾지 못했습니다", notes };
  return {
    cands,
    reason: exactU.length > 1 ? "같은 이름의 종목이 여럿입니다" : "정확히 같은 이름이 없어 비슷한 종목을 보여줍니다",
    notes,
  };
}

/** 입력 이름이 후보 중 하나의 공식 이름과 같으면 그 후보 */
function pickByNameHint(cands: BulkCandidate[], hint?: string): BulkCandidate | undefined {
  if (!hint) return undefined;
  const k = normalizeCorpName(hint);
  const ku = normalizeUsName(hint);
  const hits = cands.filter(
    (c) => normalizeCorpName(c.name) === k || (c.market === "us" && normalizeUsName(c.name) === ku),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

export async function resolveBulkEntries(
  entries: BulkEntry[],
  defaultMarket?: MarketId,
): Promise<BulkResolvedRow[]> {
  const lists = makeLists();
  const naverLimit = limiter(NAVER_CONCURRENCY);

  const resolveOne = async (e: BulkEntry): Promise<BulkResolvedRow> => {
    const base: BulkResolvedRow = {
      line: e.line,
      raw: e.raw,
      input: { market: e.market, code: e.code, name: e.name },
      groupName: e.groupName,
      tags: e.tags,
      note: e.note,
      status: "notFound",
    };
    if (e.badMarket) {
      return { ...base, reason: `시장 값을 알아볼 수 없습니다: ${e.badMarket} (kr/us/jp · 한국/미국/일본)` };
    }
    const market = e.market ?? defaultMarket;

    let found: Found | null = null;
    if (e.code) {
      found = await byCode(lists, e.code, market);
      // 코드로 못 찾았으면 이름(이름 열 또는 코드 칸의 영문 단어 — "NAVER")으로
      if (found.cands.length === 0) {
        const alt = e.name ?? (/^[A-Za-z][A-Za-z0-9 .&\-]*$/.test(e.code) ? e.code : undefined);
        if (alt) {
          const byN = await byName(lists, alt, market, naverLimit);
          if (byN.cands.length > 0) {
            found = { ...byN, notes: [`코드 ${e.code} 로는 찾지 못해 이름으로 찾았습니다`, ...(byN.notes ?? [])] };
            if (e.name && byN.cands.length === 1) found.guess = true; // 코드와 이름이 어긋남 — 확인받는다
          }
        }
      }
    } else if (e.name) {
      found = await byName(lists, e.name, market, naverLimit);
    }
    if (!found || found.cands.length === 0) {
      return {
        ...base,
        reason: found?.reason ?? "코드·종목명이 없습니다",
        notes: found?.notes?.length ? found.notes : undefined,
      };
    }

    let notes = [...(found.notes ?? [])];
    let pick: BulkCandidate | undefined;
    if (found.cands.length === 1 && !found.guess && !found.reason) pick = found.cands[0];
    // 후보가 여럿이거나 추측이어도 같은 행의 종목명이 정확히 하나를 가리키면 그것
    if (!pick && e.code && e.name) {
      pick = pickByNameHint(found.cands, e.name);
      if (!pick) {
        // 다른 언어로 쓴 이름(7203 · 토요타자동차) — 이름으로 정확히 하나를 찾았고 그게 후보 안에 있으면
        const byN = await byName(lists, e.name, market, naverLimit);
        const one = byN.cands.length === 1 && !byN.reason ? byN.cands[0] : undefined;
        if (one) pick = found.cands.find((c) => candKey(c) === candKey(one));
      }
      if (pick) {
        notes = notes.filter((m) => !m.startsWith("4자리 숫자는"));
        notes.push("같은 행의 종목명으로 확인했습니다");
      }
    }

    // 코드와 종목명이 함께 있는데 이름이 공식명과 다르면, 이름이 가리키는 종목도 찾아
    // 서로 다른 종목이면 둘 다 후보로 — 어느 쪽이 맞는지 사람이 고른다
    if (pick && e.code && e.name && !pickByNameHint([pick], e.name)) {
      const other = await byName(lists, e.name, market, naverLimit);
      const o = other.cands.length === 1 && !other.reason ? other.cands[0] : undefined;
      if (o && candKey(o) !== candKey(pick)) {
        return {
          ...base,
          status: "candidates",
          candidates: [pick, o],
          reason: `코드(${e.code})와 종목명(${e.name})이 서로 다른 종목을 가리킵니다`,
          notes: notes.length ? notes : undefined,
        };
      }
    }

    if (pick) {
      if (e.code && e.name && HANGUL.test(e.name) && pick.market === "kr") {
        if (normalizeCorpName(e.name) !== normalizeCorpName(pick.name)) {
          notes.push(`입력 이름 "${e.name}" 와 공식 종목명이 다릅니다`);
        }
      }
      return { ...base, status: "confirmed", match: pick, notes: notes.length ? notes : undefined };
    }
    return {
      ...base,
      status: "candidates",
      candidates: found.cands,
      reason: found.reason ?? (found.guess ? "추측이라 확인이 필요합니다" : "후보가 여럿입니다"),
      notes: notes.length ? notes : undefined,
    };
  };

  // 네이버 호출만 limiter 로 묶고 행 단위는 순서대로 모은다(목록은 메모리 캐시)
  return Promise.all(entries.map(resolveOne));
}
