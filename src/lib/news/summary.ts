import "server-only";
import { type NewsSummaryDoc, type SummaryBasis, getNewsSummaries, saveNewsSummary } from "@/lib/db/news-summary";
import { type AltArticle, fetchArticleText, findAlternateCoverage, resolveGoogleNewsUrl } from "./article";
import { NewsGeminiQuotaError, isNewsGeminiConfigured, newsGeminiText } from "./gemini-free";

/**
 * 해외 시황 뉴스 한글 제목 + 요약(2026-10-14, post0318/4 글로벌 뉴스 요약과 같은 방식).
 *
 * 왜: 해외 시황 제목은 무료 번역(Google 웹 엔드포인트) 묶음 번역인데, 운영 IP 가 한도(429)에 걸리면 영문 10분을 쉬고
 * MyMemory 로 5건만 메워 30건 중 28건이 원문으로 나갔다(운영 실측 2026-10-14). 요약을 만들 때 Gemini 가 한글 제목도
 * 같이 만들고 저장해, 목록은 저장된 한글 제목을 먼저 쓴다(없으면 지금 무료 번역).
 *
 * 비용 0: 결제 미연결 무료 키(`NEWS_GEMINI_API_KEY`)만. 새 기사(저장본 없음)만 Gemini 에 보낸다 — 사용량 = 새 기사 수.
 * 예약 작업 1회에 최대 MAX_PER_RUN 건, 기사 사이 GAP_MS(무료 등급 분당 한도), 모든 모델 429 면 그 회차 중단.
 */

const MIN_TEXT = 400;
const PER_ITEM_TIMEOUT_MS = 90_000;
const GAP_MS = 7_000;

/** 지시문 버전 — 올리면 그보다 옛 저장본은 다시 만든다 */
export const SUMMARY_VERSION = 1;

export const SUMMARY_PROMPT = `너는 한국 투자자를 위해 해외 경제·시장 영문 기사를 정리한다.
반드시 아래 JSON 하나만 출력한다(코드블록·설명 없이):
{"titleKo":"자연스러운 한국어 기사 제목","bullets":["요약 문장", "..."]}
- titleKo 는 원문 제목의 뜻을 그대로 옮긴 한국어 제목(과장·추가 해석 없이).
- bullets 는 5~8개, 각 1~2문장(최대 150자). 기사를 읽지 않아도 내용을 파악할 수 있을 만큼 자세히.
- 순서: 핵심 사건 → 수치·시장 반응(지수·금리·환율·유가·주가 등) → 배경·원인 → 주요 인물·기관의 발언(누가 무엇을 말했는지) → 기사에 나온 전망·다음 일정. 기사에 없는 항목은 건너뛴다.
- 기사에 있는 사실만 쓴다. 수치·인명·날짜·기관명은 기사 그대로.
- 기사에 없는 전망·평가를 덧붙이지 않는다(기사 속 인물·기관의 전망은 출처를 밝혀 써도 된다).
- 고유명사는 통용 한글 표기(파월, 연준, 엔비디아), FOMC·CPI 등 약어는 그대로.
- 기사 본문을 읽을 수 없으면 titleKo 만 채우고 bullets 는 빈 배열로 출력한다.`;

interface Prepared {
  url: string;
  text: string;
  alt: AltArticle[];
}

async function prepare(link: string, title: string): Promise<Prepared> {
  const url = (await resolveGoogleNewsUrl(link)) ?? link;
  const text = await fetchArticleText(url);
  const alt = text.length >= MIN_TEXT ? [] : await findAlternateCoverage(title, url, MIN_TEXT);
  return { url, text, alt };
}

const basisOf = (a: Prepared): SummaryBasis => (a.text.length >= MIN_TEXT ? "article" : a.alt.length ? "other" : "link");

function inputOf(title: string, a: Prepared): string {
  switch (basisOf(a)) {
    case "article":
      return `제목: ${title}\n원문: ${a.url}\n\n본문:\n${a.text}`;
    case "other":
      return (
        `제목: ${title}\n원문(${a.url})은 유료 구독·접근 차단으로 읽을 수 없어, 같은 사건을 다룬 ` +
        `다른 매체 기사를 준다. 이 기사들이 위 제목과 같은 사건일 때만 그 기사들에 있는 사실로 ` +
        `요약하고(titleKo 는 원문 제목의 번역), 다른 사건이면 bullets 를 빈 배열로 출력하라.\n\n` +
        a.alt.map((x, i) => `[다른 매체 ${i + 1}: ${x.source}]\n${x.text}`).join("\n\n")
      );
    default:
      return `제목: ${title}\n아래 링크의 기사를 읽고 정리하라.\n${a.url}`;
  }
}

export function parseSummary(text: string): { titleKo: string; bullets: string[] } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { titleKo?: unknown; bullets?: unknown };
    const titleKo = typeof j.titleKo === "string" ? j.titleKo.trim().slice(0, 200) : "";
    const bullets = Array.isArray(j.bullets)
      ? j.bullets.filter((b): b is string => typeof b === "string" && b.trim() !== "").map((b) => b.trim().slice(0, 300))
      : [];
    return { titleKo, bullets: bullets.slice(0, 8) };
  } catch {
    return null;
  }
}

/** 저장본이 없거나 옛 지시문 버전이면 만든다 */
export const needsSummary = (d: NewsSummaryDoc | undefined) => !d || d.v < SUMMARY_VERSION;

export interface SummaryRunResult {
  configured: boolean;
  candidates: number;
  pending: number;
  saved: number;
  unreadable: number;
  failed: { title: string; error: string }[];
  stoppedByQuota: boolean;
  models: Record<string, number>;
}

/**
 * 목록(최신순) 중 저장본이 없는 기사를 maxItems 건까지 요약해 저장한다. deadline 을 넘기면 남은 것은 다음 회차로.
 */
export async function summarizePending(
  items: { url: string; title: string }[],
  opts: { maxItems: number; deadline: number },
): Promise<SummaryRunResult> {
  const out: SummaryRunResult = {
    configured: isNewsGeminiConfigured(),
    candidates: items.length,
    pending: 0,
    saved: 0,
    unreadable: 0,
    failed: [],
    stoppedByQuota: false,
    models: {},
  };
  const saved = await getNewsSummaries(items.map((i) => i.url));
  const todo = items.filter((i) => needsSummary(saved.get(i.url)));
  out.pending = todo.length;
  if (!out.configured) return out;
  const exhausted = new Set<string>();
  let n = 0;
  for (const it of todo.slice(0, opts.maxItems)) {
    if (Date.now() + PER_ITEM_TIMEOUT_MS > opts.deadline) break;
    if (n++ > 0) await new Promise((r) => setTimeout(r, GAP_MS));
    try {
      const a = await prepare(it.url, it.title);
      const basis = basisOf(a);
      const { text, model } = await newsGeminiText({
        system: SUMMARY_PROMPT,
        user: inputOf(it.title, a),
        timeoutMs: PER_ITEM_TIMEOUT_MS,
        readUrls: basis === "link",
        exhausted,
      });
      const parsed = parseSummary(text);
      if (!parsed || !parsed.titleKo) throw new Error(`응답 해석 실패: ${text.slice(0, 120)}`);
      await saveNewsSummary({
        link: it.url,
        title: it.title,
        titleKo: parsed.titleKo,
        bullets: parsed.bullets,
        url: a.url,
        basis,
        sources: basis === "other" ? a.alt.map(({ url, source }) => ({ url, source })) : undefined,
        model,
        v: SUMMARY_VERSION,
      });
      out.saved++;
      if (!parsed.bullets.length) out.unreadable++;
      out.models[model] = (out.models[model] ?? 0) + 1;
    } catch (e) {
      // 저장 안 됐으므로 다음 회차에 다시 시도된다
      out.failed.push({ title: it.title.slice(0, 80), error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      if (e instanceof NewsGeminiQuotaError) {
        out.stoppedByQuota = true;
        break;
      }
    }
  }
  return out;
}
