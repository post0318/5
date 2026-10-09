import "server-only";
import { getCachedTranslations, setCachedTranslation } from "@/lib/db/translation-cache";
import type { FinancialStatement } from "../types";
import { JA_COMPANY_KO, JA_KO, JA_ELEMENT_KO } from "./ko-dict";

/**
 * 일본 종목 화면 한국어화(오너 지시 2026-10-09 — "일본주식의 개요·재무제표 등이 한자로 되어 있는데 한글로 되어 있어야 한다").
 * LLM 은 쓰지 않는다. 순서:
 *   ① 결정적 사전(ko-dict.ts — 회사가 쓴 일본어 표기 그대로 → 한국어. 같은 개념이라도 회사 표기(売上高·営業収益·売上収益)를 살린다)
 *   ② 계정 요소 ID 사전(라벨이 사전에 없을 때 — 표준 요소만)
 *   ③ 무료 번역(Google 사전 확장 엔드포인트 — 40개씩 한 요청, 결과는 뉴스 번역과 같은 translation_cache DB 에 저장해 같은 문구는
 *      다시 번역하지 않는다. 뉴스의 문구별 요청 방식은 계정명 수십 개를 한 번에 보내면 곧 429 라 묶음 요청을 따로 둔다)
 *   ④ 그래도 실패하면 원문 그대로(다음 요청 때 다시 시도)
 * 원문은 지우지 않는다 — 계정명은 accountNameLocal(화면 툴팁), 문장 속 원문 용어는 「한국어(原文)」로 병기한다.
 * 숫자·단위·부호는 건드리지 않는다.
 */

/** 히라가나·가타카나·한자 */
const JA_CHAR = /[぀-ヿ㐀-䶿一-鿿々〆ヵヶ]/;
export const hasJa = (s: string | null | undefined): boolean => !!s && JA_CHAR.test(s);

/** 사전 열쇠 — 전각 숫자·괄호·기호를 반각으로, 공백 제거 */
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

const DICT = new Map<string, string>(Object.entries(JA_KO).map(([k, v]) => [norm(k), v]));

/** 사전 조회(동기) — 없으면 null. 고정 꼴(第N期 등)은 규칙으로 */
export function jaDict(s: string): string | null {
  const k = norm(s);
  const hit = DICT.get(k);
  if (hit) return hit;
  const ki = k.match(/^第(\d+)期$/);
  if (ki) return `제${ki[1]}기`;
  const kq = k.match(/^第(\d+)期第(\d+)四半期$/);
  if (kq) return `제${kq[1]}기 ${kq[2]}분기`;
  const mm = k.match(/^(\d+)月(\d+)日$/);
  if (mm) return `${mm[1]}월 ${mm[2]}일`;
  const yy = k.match(/^(\d{4})年$/);
  if (yy) return `${yy[1]}년`;
  return null;
}

/** 한국어 회사명 검색어 → 사전의 일본어 원문(종목 검색 "도요타" → トヨタ自動車) */
export function jaNamesForKo(query: string): string[] {
  const q = query.replace(/\s+/g, "");
  if (!/[가-힣]/.test(q)) return [];
  return Object.entries(JA_COMPANY_KO)
    .filter(([, ko]) => ko.replace(/\s+/g, "").includes(q))
    .map(([ja]) => ja.normalize("NFKC"));
}

/** "is:jpigp_cor:OperatingProfitLossIFRS#0" → "OperatingProfitLossIFRS"(표준 요소만, 회사 확장 ext 는 null) */
function elementOf(accountId: string | undefined): string | null {
  if (!accountId) return null;
  const m = accountId.match(/^(?:[a-z]+:)?(jppfs_cor|jpigp_cor|jpcrp_cor|ifrs-full):([A-Za-z0-9_]+)/);
  return m ? m[2] : null;
}

const DEADLINE_MS = 20_000;
const BATCH = 40;
/** 무료 번역 엔드포인트가 막히면(429 등) 이 시각까지 번역을 쉰다 — 같은 서버의 뉴스 번역까지 막히지 않게 */
let pausedUntil = 0;
const memo = new Map<string, string>();

/**
 * 사전에 없는 문구 → 무료 번역. 같은 문구는 translation_cache(DB, 뉴스 번역과 같은 저장소)·메모리에서 재사용하고,
 * 새 문구만 한 요청에 40개씩 묶어 보낸다(Google 사전 확장 엔드포인트 — 문구마다 요청하면 금방 429).
 */
async function translateBatch(texts: string[], deadlineMs: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const need: string[] = [];
  for (const t of texts) {
    const m = memo.get(t);
    if (m) out.set(t, m);
    else need.push(t);
  }
  if (!need.length) return out;
  const cached = await getCachedTranslations("ja", need);
  const miss: string[] = [];
  for (const t of need) {
    const c = cached.get(t);
    if (c && !hasJa(c)) {
      out.set(t, c);
      memo.set(t, c);
    } else miss.push(t);
  }
  const deadline = Date.now() + deadlineMs;
  for (let i = 0; i < miss.length && Date.now() < deadline && Date.now() >= pausedUntil; i += BATCH) {
    const b = miss.slice(i, i + BATCH);
    try {
      const res = await fetch(
        "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=ja&tl=ko&" + b.map((x) => "q=" + encodeURIComponent(x)).join("&"),
        { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000), cache: "no-store" },
      );
      if (!res.ok) {
        pausedUntil = Date.now() + 15 * 60_000;
        console.warn(`[jp-ko] 번역 HTTP ${res.status} — 15분 쉼`);
        break;
      }
      const d = (await res.json()) as unknown;
      if (!Array.isArray(d) || d.length !== b.length) break;
      b.forEach((t, j) => {
        const v = d[j];
        const ko = (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")).trim();
        if (!ko || hasJa(ko) || ko === t) return;
        out.set(t, ko);
        memo.set(t, ko);
        void setCachedTranslation("ja", t, ko, true);
      });
    } catch {
      break;
    }
  }
  if (memo.size > 5000) memo.clear();
  return out;
}

/**
 * 문구 여러 개 → 한국어(사전 → 요소 ID 사전 → 번역). 실패한 것은 결과에 없다(호출부가 원문 유지).
 * 번역은 시간 예산 안에서만 — 넘치면 이번 응답은 원문, 다음 요청에서 이어서(번역 결과는 DB 캐시).
 */
export async function jaToKoMany(
  texts: string[],
  elementHint?: Map<string, string | null>,
  deadlineMs = DEADLINE_MS,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo: string[] = [];
  for (const t of new Set(texts)) {
    if (!hasJa(t)) continue;
    const el = elementHint?.get(t);
    const d = jaDict(t) ?? (el ? JA_ELEMENT_KO[el] : undefined) ?? null;
    if (d) out.set(t, d);
    else todo.push(t);
  }
  if (todo.length) {
    const tr = await translateBatch(todo.map((t) => t.normalize("NFKC")), deadlineMs);
    let missed = 0;
    for (const t of todo) {
      const ko = tr.get(t.normalize("NFKC"));
      if (ko) out.set(t, ko);
      else missed++;
    }
    if (missed) console.warn(`[jp-ko] 번역 못 한 문구 ${missed}건 — 원문 표시(다음 요청에서 재시도)`);
  }
  return out;
}

/** 문장 속 일본어 덩어리(앞뒤 영숫자·괄호 포함) */
const JA_RUN = /[A-Za-z0-9]*[぀-ヿ㐀-䶿一-鿿々〆ヵヶ][぀-ヿ㐀-䶿一-鿿々〆ヵヶ・ー、A-Za-z0-9△]*(?:\([぀-ヿ㐀-䶿一-鿿々ー△]+\)[぀-ヿ㐀-䶿一-鿿々〆ヵヶ・ー]*)?/g;

function runsOf(s: string): string[] {
  return [...s.normalize("NFKC").matchAll(JA_RUN)].map((m) => m[0]);
}

/** 문장 속 일본어 덩어리를 「한국어(原文)」로(keepOriginal=false 면 한국어만) — 번역 맵은 jaToKoMany 결과 */
function inlineWith(s: string, map: Map<string, string>, keepOriginal = true): string {
  return s.normalize("NFKC").replace(JA_RUN, (run) => {
    const ko = map.get(run);
    return ko ? (keepOriginal ? `${ko}(${run})` : ko) : run;
  });
}

/** 문장 하나 → 일본어 용어를 「한국어(原文)」로 */
export async function jaInline(s: string): Promise<string> {
  if (!hasJa(s)) return s;
  return inlineWith(s, await jaToKoMany(runsOf(s)));
}

/**
 * 문장 여러 개 한 번에(번역 요청을 모아서). 문장 전체가 사전에 있으면 그 값, 아니면 덩어리별로.
 * keepOriginal=false 는 원문을 따로 남기는 곳(공시 제목 → titleLocal)용.
 */
export async function jaInlineMany(
  list: (string | null | undefined)[],
  opts: { keepOriginal?: boolean } = {},
): Promise<(s: string) => string> {
  const keep = opts.keepOriginal ?? true;
  const runs = list.flatMap((s) => (s && hasJa(s) && !jaDict(s) ? runsOf(s) : []));
  const map = runs.length ? await jaToKoMany(runs) : new Map<string, string>();
  return (s: string) => {
    if (!hasJa(s)) return s;
    const whole = jaDict(s);
    if (whole) return keep ? `${whole}(${s.normalize("NFKC")})` : whole;
    return inlineWith(s, map, keep);
  };
}

/**
 * 재무제표·재무분석 응답 한국어화 — 계정명은 통째로 번역(원문은 accountNameLocal), 칸 주석·출처 문구는 용어 병기.
 * 객체를 바꿔서 돌려준다.
 */
export async function koreanizeStatement(st: FinancialStatement): Promise<FinancialStatement> {
  const items = st.sections.flatMap((s) => s.items);
  const hint = new Map<string, string | null>();
  for (const it of items) if (hasJa(it.accountName) && !hint.has(it.accountName)) hint.set(it.accountName, elementOf(it.accountId));
  const notes = [st.source, ...items.flatMap((it) => Object.values(it.cellNotes ?? {}))];
  const [names, inline] = await Promise.all([jaToKoMany([...hint.keys()], hint), jaInlineMany(notes)]);
  for (const sec of st.sections) {
    if (hasJa(sec.title)) sec.title = names.get(sec.title) ?? sec.title;
    for (const it of sec.items) {
      const ko = names.get(it.accountName);
      if (ko) {
        it.accountNameLocal = it.accountName;
        it.accountName = ko;
      }
      if (it.cellNotes) for (const k of Object.keys(it.cellNotes)) it.cellNotes[k] = inline(it.cellNotes[k]);
    }
  }
  if (st.source) st.source = inline(st.source);
  if (st.unit === "円") st.unit = "엔";
  return st;
}

/** 원문 보존 필드 — 손대지 않는다 */
const LOCAL_KEYS = new Set(["nameLocal", "accountNameLocal", "titleLocal", "labelLocal"]);

/**
 * 깊은 객체의 문자열 중 일본어가 섞인 것을 「한국어(原文)」로(하이라이트·TTM·컨센서스·개요의 주석·사유 문구) — 열쇠는 그대로,
 * *Local 원문 필드는 건너뛴다. only 를 주면 그 열쇠의 값만.
 */
export async function koreanizeNotesDeep<T>(obj: T, only?: Set<string>): Promise<T> {
  const strs: string[] = [];
  const take = (k: string | null) => (k == null ? !only : only ? only.has(k) : !LOCAL_KEYS.has(k));
  (function walk(v: unknown, k: string | null) {
    if (typeof v === "string") {
      if (take(k) && hasJa(v)) strs.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
    else if (v && typeof v === "object") for (const [kk, x] of Object.entries(v)) walk(x, kk);
  })(obj, null);
  if (!strs.length) return obj;
  const inline = await jaInlineMany(strs);
  return (function map(v: unknown, k: string | null): unknown {
    if (typeof v === "string") return take(k) ? inline(v) : v;
    if (Array.isArray(v)) return v.map((x) => map(x, k));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, map(x, kk)]));
    return v;
  })(obj, null) as T;
}
