import "server-only";
import { getCachedTranslation, setCachedTranslation } from "../db/translation-cache";

/**
 * 뉴스 제목 번역 + 가벼운 왕복검증. 무인증 Google 번역 웹 엔드포인트를 먼저 쓰고
 * (품질 양호), 실패하면 MyMemory로 폴백한다. LLM 토큰·유료 API 없음.
 * (post0318/4 프로젝트의 src/lib/server/translate.ts 동일 패턴을 이식)
 *
 * translateChecked: 번역 후 역번역이 원문과 크게 어긋나면(오역 의심) ok:false 로
 * 표시해 화면에서 원문을 우선 노출하게 한다.
 */

const REQ_TIMEOUT_MS = 3500;

/**
 * 성공한 번역 결과 메모이즈(2026-09, 오너 지적 — "거시경제 해외뉴스에 번역이
 * 안 된 게 있다"). 원인: translateTitles 는 라우트 1회 호출당 동시성 5·전체
 * 7초 예산 안에서만 번역을 시도하고 예산을 넘기면 원문 그대로 둔다(라우트
 * 전체가 느려지는 것 방지 목적, 의도된 동작) — 그런데 거시경제 해외뉴스는
 * 후보가 최대 30건(야후 3개 주제어 + 구글 뉴스 RSS 합산)까지 늘어나 동시성
 * 5개로는 예산 안에 다 처리 못 하는 경우가 실측으로 확인됨. RSS 원본은
 * 15분 캐시(googleNews.ts)라 같은 기사가 여러 번 재조회되는데, 캐시가 없으면
 * 이전에 성공한 번역까지 매번 처음부터 다시 시도해(불필요한 API 호출 반복,
 * 무료 엔드포인트 레이트리밋 위험 증가) 실패 확률만 계속 유지된다. 이 메모리
 * 캐시는 한 번 성공한 번역은 24시간 재사용해 다음 요청부터 그 항목은 예산을
 * 안 쓰고, 남은 예산을 아직 못 번역한 새 항목에 더 쓸 수 있게 한다(실패는
 * 캐시하지 않음 — 다음 요청에서 다시 시도, 대부분 일시적 오류라 재시도가
 * 안전). 서버리스 인스턴스 재시작 시 초기화되지만(Fluid Compute 는 인스턴스
 * 재사용이 잦아 실무상 효과 있음), 인스턴스가 살아있는 동안은 계속 누적.
 */
const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 2000;
const translationCache = new Map<string, { ko: string; ok: boolean; at: number }>();

function cacheGet(key: string): { ko: string; ok: boolean } | null {
  const e = translationCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }
  return e;
}

function cacheSet(key: string, ko: string, ok: boolean) {
  if (translationCache.size >= CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) translationCache.delete(oldest);
  }
  translationCache.set(key, { ko, ok, at: Date.now() });
}

/**
 * 무료 번역 엔드포인트가 막히면 쉬는 시각 — **원문 언어(경로)별**로 따로 둔다(2026-10-10 운영 — 일본 종목 한 번 갱신에 일본어 제목 90건 안팎을
 * 한 건씩 번역하다 Google 429 를 받았고, 그 쉬기가 프로세스 전체에 걸려 미국·한국 종목의 영문 기사 번역까지 멈췄다). Google 429 는 15분,
 * MyMemory 429·하루 한도 소진은 1시간. 쉬는 동안 그 언어는 그 경로를 부르지 않고 다음 경로로 간다(둘 다 쉬면 원문 제목 그대로 — 실패는
 * 캐시하지 않으므로 다음 갱신 때 다시 번역된다). 일본 재무 문구 번역(jp/ko.ts)의 쉬기와도 따로다.
 */
type Lane = "en" | "ja";
const googlePausedUntil: Record<Lane, number> = { en: 0, ja: 0 };
const myMemoryPausedUntil: Record<Lane, number> = { en: 0, ja: 0 };
const GOOGLE_PAUSE_MS = 15 * 60_000;
const MYMEMORY_PAUSE_MS = 60 * 60_000;

function googlePaused(lane: Lane): boolean {
  return Date.now() < googlePausedUntil[lane];
}

function pauseGoogle(lane: Lane) {
  if (!googlePaused(lane)) console.warn(`[translate] Google 번역 429 — ${lane} 제목 15분 쉼(다른 언어는 계속)`);
  googlePausedUntil[lane] = Date.now() + GOOGLE_PAUSE_MS;
}

/** gtx 응답(문장 조각 배열)을 한 문자열로 */
function joinGtx(data: unknown): string | null {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return (data[0] as unknown[]).map((seg) => (Array.isArray(seg) ? String(seg[0] ?? "") : "")).join("");
}

async function viaGoogle(text: string, sl: string, tl: string, lane: Lane): Promise<string | null> {
  if (googlePaused(lane)) return null;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=` + encodeURIComponent(text);
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    if (res.status === 429) {
      pauseGoogle(lane);
      return null;
    }
    if (!res.ok) return null;
    return joinGtx(await res.json())?.trim() || null;
  } catch {
    return null;
  }
}

/** 묶음 번역 한 번에 넣는 제목 수·글자 수 상한(POST 본문, 응답 지연·잘림 방지) */
const BATCH_MAX_ITEMS = 25;
const BATCH_MAX_CHARS = 1800;

/**
 * 여러 제목을 한 요청으로 번역 — 줄바꿈으로 이어 POST 로 보내고 결과를 줄바꿈으로 다시 나눈다(2026-10-10 실측: gtx 가 줄을 그대로 지킨다).
 * 결과 줄 수가 입력과 다르면 null(호출부가 그 묶음만 한 건씩 번역). 요청 수가 제목 수의 1/20 안팎이 된다.
 */
async function viaGoogleBatch(texts: string[], sl: string, tl: string, lane: Lane): Promise<(string | null)[] | null> {
  if (googlePaused(lane)) return null;
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t`, {
      method: "POST",
      headers: { "user-agent": "Mozilla/5.0", "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "q=" + encodeURIComponent(texts.join("\n")),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS * 2),
    });
    if (res.status === 429) {
      pauseGoogle(lane);
      return null;
    }
    if (!res.ok) return null;
    const joined = joinGtx(await res.json());
    if (joined == null) return null;
    const lines = joined.split("\n");
    if (lines.length !== texts.length) return null;
    return lines.map((l) => l.trim() || null);
  } catch {
    return null;
  }
}

async function viaMyMemory(text: string, sl: string, lane: Lane): Promise<string | null> {
  if (Date.now() < myMemoryPausedUntil[lane]) return null;
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|ko`, {
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (res.status === 429) {
      myMemoryPausedUntil[lane] = Date.now() + MYMEMORY_PAUSE_MS;
      console.warn(`[translate] MyMemory 429 — ${lane} 제목 1시간 쉼`);
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { responseStatus?: number; responseData?: { translatedText?: string } };
    const out = data.responseData?.translatedText;
    if (/ALL AVAILABLE FREE TRANSLATIONS/i.test(out ?? "")) {
      myMemoryPausedUntil[lane] = Date.now() + MYMEMORY_PAUSE_MS;
      console.warn(`[translate] MyMemory 하루 한도 — ${lane} 제목 1시간 쉼`);
      return null;
    }
    if (!out || data.responseStatus !== 200) return null;
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** 두 문자열의 내용어 집합 Dice 계수 (0~1) */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** sl(원문 언어) → 한국어. sl="ko"면 번역 없이 그대로 통과. */
export interface TranslateOptions {
  /**
   * 무료 경로(Google·MyMemory)가 모두 실패했을 때 Claude Haiku로 폴백할지.
   * 기본 true. 거시경제 시황 뉴스는 오너 지시(2026-09-15)로 false — 해외시황
   * 헤드라인에는 LLM을 붙이지 않는다(실패 시 원문 노출).
   */
  llmFallback?: boolean;
}

/** 메모리 → DB 캐시 조회(있으면 메모리에도 채움) */
async function cachedTranslation(sl: Lane, src: string): Promise<{ ko: string; ok: boolean } | null> {
  const key = `${sl}:${src}`;
  const mem = cacheGet(key);
  if (mem) return mem;
  // DB 캐시(인스턴스 재시작에도 살아남음) — 오너 지적 2026-09 "새로고침할 때마다 번역이 달라진다"
  const db = await getCachedTranslation(sl, src);
  if (db) cacheSet(key, db.ko, db.ok);
  return db;
}

function remember(sl: Lane, src: string, ko: string, ok: boolean) {
  cacheSet(`${sl}:${src}`, ko, ok);
  void setCachedTranslation(sl, src, ko, ok);
}

export async function translateChecked(
  src: string,
  sl: "en" | "ja" | "ko",
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 호출부 호환용(유료 폴백 제거 뒤 쓰지 않음)
  _opts: TranslateOptions = {},
): Promise<{ ko: string | null; ok: boolean }> {
  if (sl === "ko") return { ko: src, ok: true };
  const cached = await cachedTranslation(sl, src);
  if (cached) return cached;
  // 1) Google + 영문만 왕복검증(dice 계수는 알파벳 기준이라 일본어엔 약함 — 실패해도 원문 노출이라 안전)
  const gk = await viaGoogle(src, sl, "ko", sl);
  if (gk && gk.trim() !== src.trim()) {
    const back = sl === "en" ? await viaGoogle(gk, "ko", sl, sl) : null;
    const ok = back ? dice(contentWords(back), contentWords(src)) >= 0.3 : true;
    remember(sl, src, gk, ok);
    return { ko: gk, ok };
  }
  // 2) Google 실패/미번역 → MyMemory 폴백 (왕복검증 생략)
  const mk = await viaMyMemory(src, sl, sl);
  if (mk && mk.trim() !== src.trim()) {
    remember(sl, src, mk, true);
    return { ko: mk, ok: true };
  }
  // 3) 무료 경로 둘 다 실패하면 원문 제목 그대로(2026-10-03 — 종목뉴스 Claude 사용 금지, 유료 폴백 제거). 실패는 캐시하지 않음.
  return { ko: null, ok: false };
}

/** 갱신 1회에 새로 번역하는 제목 상한(앞쪽 = 최신순 N건) — 나머지는 원문으로 두고 다음 갱신 때(캐시에 없는 것만) 이어서 번역한다 */
const MAX_NEW_TRANSLATIONS = 40;
/** MyMemory 폴백은 한 건씩이라 회당 이만큼만 */
const MAX_MYMEMORY_FALLBACK = 5;

/**
 * 여러 제목을 시간예산(DEADLINE_MS) 안에서 번역한다(2026-10-10 운영 429 대응으로 다시 짰다):
 *  - 캐시(메모리·DB)에 있는 제목은 그대로 쓰고, 없는 제목 중 앞쪽 MAX_NEW_TRANSLATIONS 건만 새로 번역한다(호출부는 최신순으로 넘긴다).
 *  - 새 제목은 BATCH_MAX_ITEMS·BATCH_MAX_CHARS 단위로 묶어 한 요청에(영문은 왕복검증도 묶음으로). 묶음 결과 줄 수가 안 맞으면 그 묶음만 한 건씩.
 *  - Google 이 막히면(그 언어만 쉼) 몇 건만 MyMemory, 나머지·예산 초과는 원문 그대로.
 */
export async function translateTitles<T>(
  items: T[],
  sl: "en" | "ja" | "ko",
  getTitle: (item: T) => string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 호출부 호환용
  _opts: TranslateOptions = {},
): Promise<{ titleKo: string; translationOk: boolean }[]> {
  const srcs = items.map((it) => getTitle(it));
  if (sl === "ko") return srcs.map((s) => ({ titleKo: s, translationOk: true }));
  const lane: Lane = sl;
  const DEADLINE_MS = 7000;
  const deadline = Date.now() + DEADLINE_MS;
  const result = new Map<string, { ko: string; ok: boolean }>();

  const unique = [...new Set(srcs)];
  const cached = await Promise.all(unique.map((s) => cachedTranslation(lane, s).catch(() => null)));
  unique.forEach((s, i) => {
    const c = cached[i];
    if (c) result.set(s, c);
  });
  // 줄바꿈이 섞인 제목은 묶음 구분자와 겹치므로 공백으로
  const todo = unique.filter((s) => !result.has(s)).slice(0, MAX_NEW_TRANSLATIONS);
  const clean = (s: string) => s.replace(/\s*\n\s*/g, " ");

  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const s of todo) {
    const l = clean(s).length + 1;
    if (cur.length && (cur.length >= BATCH_MAX_ITEMS || len + l > BATCH_MAX_CHARS)) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += l;
  }
  if (cur.length) chunks.push(cur);

  for (const chunk of chunks) {
    if (Date.now() >= deadline || googlePaused(lane)) break;
    let kos = await viaGoogleBatch(chunk.map(clean), sl, "ko", lane);
    if (!kos && !googlePaused(lane)) {
      // 줄 수가 안 맞는 묶음 — 그 묶음만 한 건씩
      kos = [];
      for (const s of chunk) {
        if (Date.now() >= deadline || googlePaused(lane)) break;
        kos.push(await viaGoogle(clean(s), sl, "ko", lane));
      }
    }
    if (!kos) continue;
    const got = chunk.map((s, i) => ({ s, ko: kos![i] ?? null })).filter((x) => x.ko && x.ko.trim() !== x.s.trim());
    // 영문은 왕복검증(오역 의심이면 ok:false — 화면이 원문 우선). 일본어는 검증 없이 ok.
    let backs: (string | null)[] | null = null;
    if (sl === "en" && got.length && Date.now() < deadline) backs = await viaGoogleBatch(got.map((x) => x.ko!), "ko", "en", lane);
    got.forEach((x, i) => {
      const back = backs?.[i] ?? null;
      const ok = back ? dice(contentWords(back), contentWords(x.s)) >= 0.3 : true;
      result.set(x.s, { ko: x.ko!, ok });
      remember(lane, x.s, x.ko!, ok);
    });
  }

  // Google 이 막혔거나 못 한 제목 — 몇 건만 MyMemory(한 건씩)
  let fallback = 0;
  for (const s of todo) {
    if (result.has(s)) continue;
    if (fallback >= MAX_MYMEMORY_FALLBACK || Date.now() >= deadline || Date.now() < myMemoryPausedUntil[lane]) break;
    fallback++;
    const mk = await viaMyMemory(clean(s), sl, lane);
    if (mk && mk.trim() !== s.trim()) {
      result.set(s, { ko: mk, ok: true });
      remember(lane, s, mk, true);
    }
  }

  return srcs.map((s) => {
    const r = result.get(s);
    return r ? { titleKo: r.ko, translationOk: r.ok } : { titleKo: s, translationOk: true };
  });
}
