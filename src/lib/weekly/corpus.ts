import "server-only";
import { shinhanResearchCol, classifyResearchTopic } from "@/lib/db/shinhan-research";
import { telegramPostsCol } from "@/lib/db/telegram-posts";
import { fetchGoogleNewsRss, googleNewsUrl } from "@/lib/news/googleNews";
import { loadInfluencers } from "@/lib/influencers/store";
import { fetchYoutubeVideos } from "@/lib/influencers/youtube";
import type { ReportWeek } from "./week";

/**
 * 주간 리포트 입력 코퍼스 — 모두 이미 DB에 있거나 공개 피드인 자료만.
 *  - 증권사 리포트: kr_research `category:"산업"` 중 거시·전략·시황·AI/반도체
 *    (기업분석은 범위 밖 — 오너 지시 "거시경제이기에 기업분석은 대상에서 제외")
 *  - 텔레그램 채널 게시물(로컬 수집분)
 *  - Google 뉴스 RSS 제목(공개 신디케이션, 본문 아님)
 *  - 인플루언서 유튜브 최신 영상 제목(YouTube Data API, 키 있을 때)
 * 원문은 저장하지 않고 프롬프트에만 쓴다.
 */

const RESEARCH_KEY_RE =
  /전략|시황|매크로|채권|금리|환율|원자재|Weekly|Daily|Monthly|글로벌|Global|경제|Econ|FOMC|연준|Fed|BOJ|한은|BOK|AI|반도체|메모리|금\b|유가|원유|브라질|달러|인플레|물가|고용|Macro|Strategy|Market|FX|Credit|크레딧|국채|Treasury|Rates|Commodit|에너지|Energy|Semi/i;
const ESG_RE = /\bESG\b/i;

const NEWS_QUERIES: { q: string; locale: string }[] = [
  { q: "FOMC 금리", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "한국은행 기준금리", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "일본은행 BOJ 금리", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "국제유가", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "금값 금 시세", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "브라질 국채", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "AI 반도체 투자 우려", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "코스피 외국인", locale: "hl=ko&gl=KR&ceid=KR:ko" },
  { q: "Federal Reserve rate decision", locale: "hl=en-US&gl=US&ceid=US:en" },
  { q: "Treasury yields", locale: "hl=en-US&gl=US&ceid=US:en" },
  { q: "oil prices OPEC", locale: "hl=en-US&gl=US&ceid=US:en" },
  { q: "gold price", locale: "hl=en-US&gl=US&ceid=US:en" },
  { q: "Brazil bonds Selic", locale: "hl=en-US&gl=US&ceid=US:en" },
  { q: "AI capex hyperscaler spending", locale: "hl=en-US&gl=US&ceid=US:en" },
  { q: "Nvidia AI demand", locale: "hl=en-US&gl=US&ceid=US:en" },
  { q: "Bank of Japan", locale: "hl=en-US&gl=US&ceid=US:en" },
];

export interface WeeklyCorpus {
  text: string;
  researchCount: number;
  newsCount: number;
  telegramCount: number;
  youtubeCount: number;
}

async function researchSection(week: ReportWeek): Promise<{ text: string; count: number }> {
  const col = await shinhanResearchCol();
  // 지난주 월요일부터 실행일(월요일 오전 발간분 포함)까지
  const docs = await col
    .find({ category: "산업", date: { $gte: week.weekStart } })
    .sort({ date: -1 })
    .limit(600)
    .toArray();
  const picked = docs.filter(
    (d) =>
      !ESG_RE.test(`${d.stockName} ${d.title}`) &&
      RESEARCH_KEY_RE.test(`${d.stockName} ${d.title}`) &&
      (d.summary ?? "").length > 30,
  );
  const lines = picked.map((d) => {
    const topic = classifyResearchTopic(d);
    const summary = (d.summary ?? "").replace(/\s+/g, " ").slice(0, 600);
    return `[${d.date}|${d.market}|${topic}|${d.source}] ${d.stockName} — ${d.title}\n${summary}`;
  });
  return { text: lines.join("\n\n"), count: picked.length };
}

async function telegramSection(week: ReportWeek): Promise<{ text: string; count: number }> {
  try {
    const col = await telegramPostsCol();
    const docs = await col
      .find({ publishedAt: { $gte: `${week.weekStart}T00:00:00` } })
      .sort({ publishedAt: -1 })
      .limit(120)
      .toArray();
    const lines = docs.map(
      (d) => `[${d.publishedAt.slice(0, 10)}|${d.channelTitle}] ${d.text.replace(/\s+/g, " ").slice(0, 500)}`,
    );
    return { text: lines.join("\n"), count: docs.length };
  } catch {
    return { text: "", count: 0 };
  }
}

async function newsSection(week: ReportWeek): Promise<{ text: string; count: number }> {
  const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
  const seen = new Set<string>();
  const lines: string[] = [];
  const results = await Promise.all(
    NEWS_QUERIES.map(async ({ q, locale }) => {
      const url = googleNewsUrl(`search?q=${encodeURIComponent(q)}+when:7d`, locale);
      const items = await fetchGoogleNewsRss(url).catch(() => []);
      return { q, items };
    }),
  );
  for (const { q, items } of results) {
    for (const it of items.slice(0, 12)) {
      const t = Date.parse(it.publishedAt);
      if (Number.isFinite(t) && t < sinceMs) continue;
      const k = it.title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(`[${it.publishedAt.slice(0, 10)}|${it.source}|q:${q}] ${it.title}`);
    }
  }
  return { text: lines.join("\n"), count: lines.length };
}

async function youtubeSection(week: ReportWeek): Promise<{ text: string; count: number }> {
  if (!process.env.YOUTUBE_API_KEY) return { text: "", count: 0 };
  try {
    const influencers = await loadInfluencers();
    const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
    const lines: string[] = [];
    for (const inf of influencers) {
      if (!inf.youtubeUrl) continue;
      const videos = await fetchYoutubeVideos(inf.youtubeUrl, 15).catch(() => []);
      for (const v of videos) {
        if (Date.parse(v.publishedAt) < sinceMs) continue;
        lines.push(`[${v.publishedAt.slice(0, 10)}|${inf.name}] ${v.title}`);
      }
    }
    return { text: lines.join("\n"), count: lines.length };
  } catch {
    return { text: "", count: 0 };
  }
}

export async function buildCorpus(week: ReportWeek): Promise<WeeklyCorpus> {
  const [research, telegram, news, youtube] = await Promise.all([
    researchSection(week),
    telegramSection(week),
    newsSection(week),
    youtubeSection(week),
  ]);
  const parts = [
    `## 증권사 투자전략·시황·산업 리포트 요약 발췌 (${research.count}건, 형식 [날짜|시장|분류|출처] 제목 — 발췌)\n${research.text || "(없음)"}`,
    `## 뉴스 제목 (Google 뉴스, ${news.count}건, 형식 [날짜|매체|검색어] 제목)\n${news.text || "(없음)"}`,
    `## 텔레그램 채널 게시물 (${telegram.count}건)\n${telegram.text || "(없음)"}`,
    `## 유튜브 최신 영상 제목 (${youtube.count}건)\n${youtube.text || "(없음)"}`,
  ];
  return {
    text: parts.join("\n\n"),
    researchCount: research.count,
    newsCount: news.count,
    telegramCount: telegram.count,
    youtubeCount: youtube.count,
  };
}
