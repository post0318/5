import "server-only";

/**
 * 뉴스 제목 번역 + 가벼운 왕복검증. 무인증 Google 번역 웹 엔드포인트를 먼저 쓰고
 * (품질 양호), 실패하면 MyMemory로 폴백한다. LLM 토큰·유료 API 없음.
 * (post0318/4 프로젝트의 src/lib/server/translate.ts 동일 패턴을 이식)
 *
 * translateChecked: 번역 후 역번역이 원문과 크게 어긋나면(오역 의심) ok:false 로
 * 표시해 화면에서 원문을 우선 노출하게 한다.
 */

const REQ_TIMEOUT_MS = 3500;

async function viaGoogle(text: string, sl: string, tl = "ko"): Promise<string | null> {
  try {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=` +
      encodeURIComponent(text);
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    const out = (data[0] as unknown[])
      .map((seg) => (Array.isArray(seg) ? String(seg[0] ?? "") : ""))
      .join("")
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

async function viaMyMemory(text: string, sl: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|ko`,
      { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      responseStatus?: number;
      responseData?: { translatedText?: string };
    };
    const out = data.responseData?.translatedText;
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
export async function translateChecked(
  src: string,
  sl: "en" | "ja" | "ko",
): Promise<{ ko: string | null; ok: boolean }> {
  if (sl === "ko") return { ko: src, ok: true };
  // 1) Google 시도 + 성공 시에만 왕복검증(영어권 위주. dice 계수는 알파벳 기준이라
  //    일본어 역번역 검증엔 약함 — 실패해도 원문 노출이라 안전)
  const gk = await viaGoogle(src, sl, "ko");
  if (gk && gk.trim() !== src.trim()) {
    if (sl !== "en") return { ko: gk, ok: true };
    const back = await viaGoogle(gk, "ko", sl);
    if (!back) return { ko: gk, ok: true };
    return { ko: gk, ok: dice(contentWords(back), contentWords(src)) >= 0.3 };
  }
  // 2) Google 실패/미번역 → MyMemory 폴백 (왕복검증 생략)
  const mk = await viaMyMemory(src, sl);
  if (mk && mk.trim() !== src.trim()) return { ko: mk, ok: true };
  return { ko: null, ok: false };
}

/**
 * 여러 항목을 소수 동시성(POOL)·시간예산(DEADLINE_MS) 안에서 번역한다.
 * 예산을 넘긴 항목은 원문 그대로 둔다(라우트가 통째로 느려지는 것을 방지).
 */
export async function translateTitles<T>(
  items: T[],
  sl: "en" | "ja" | "ko",
  getTitle: (item: T) => string,
): Promise<{ titleKo: string; translationOk: boolean }[]> {
  const POOL = 5;
  const DEADLINE_MS = 7000;
  const out = new Array<{ titleKo: string; translationOk: boolean }>(items.length);
  const deadline = Date.now() + DEADLINE_MS;
  let next = 0;

  async function worker() {
    while (next < items.length && Date.now() < deadline) {
      const i = next++;
      const src = getTitle(items[i]);
      const r = await translateChecked(src, sl);
      out[i] = { titleKo: r.ko ?? src, translationOk: r.ko ? r.ok : true };
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, items.length || 1) }, worker));
  // 예산 초과로 처리 못한 항목은 원문
  for (let i = 0; i < items.length; i++) {
    if (!out[i]) out[i] = { titleKo: getTitle(items[i]), translationOk: true };
  }
  return out;
}
