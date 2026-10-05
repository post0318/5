import "server-only";
import { fetchGoogleNewsRss, googleNewsUrl } from "@/lib/news/googleNews";
import { fetchNaverNewsInRange } from "@/lib/news/naverNews";
import type { SectorHighlight, WeeklySectors } from "./sectors";
import type { ReportWeek } from "./week";

/**
 * 섹터 코멘트의 근거 기사 — 섹터를 끌고 간 종목(leaders) 이름으로 그 주 기사
 * 제목을 모은다(2026-10-05).
 *
 * 2026-09-28 주 초안에서 섹터 사유가 지어낸 것이었다(코스닥 소재 = 솔브레인·
 * 동진쎄미켐(반도체 소재)인데 "2차전지 소재", 코스피 산업재 주도주가
 * 롯데에너지머티리얼즈·팬오션인데 "방산·조선 수주"). 원인: 모델에 섹터명·
 * 등락률만 주고 주도 종목도 근거도 안 줬다 — 웹검색이 안 돈 실행에선 섹터명만
 * 보고 그럴듯한 사유를 지어냈다. 이제 주도 종목과 그 종목의 그 주 기사 제목을
 * 함께 넘기고, comment.ts 는 근거가 없거나 주도 종목을 언급하지 않은 코멘트를
 * 버린다.
 *
 * 한국 종목은 네이버 뉴스 검색, 해외 종목은 구글 뉴스 RSS(영문). 실패하면 그
 * 종목만 근거 없이 남는다.
 */

export interface SectorNews {
  /** 근거 기사 제목(매체·날짜 포함) — 최대 섹터당 6건 */
  headlines: string[];
}

const PER_LEADER = 3;

/** 사건이 아닌 시세 안내·종목 소개 페이지(실측: "… Stock Price, News, Quote & History",
 * "주가, 10월 2일 장중 …원 1.63% 하락") — 등락 사유가 아니라 등락 그 자체라 뺀다. */
const NOISE_RE =
  /Stock Price, News|Stock Forecast|Quote & History|latest stock news|History, Products|주가,?\s*\d+월\s*\d+일\s*장중|주가 변동성 확대|주차 .*주가 .*마감|보합…장중/i;

/** 해외 종목명에서 법인 접미어를 떼어 검색어로 쓴다("The Goldman Sachs Group Inc" → "Goldman Sachs"). */
export function leaderSearchName(name: string): string {
  return name
    .replace(/^The\s+/i, "")
    .replace(/\s+(Act\.|Participating|Class\s+[A-Z]\b|Registered|Common|ADR).*$/i, "")
    .replace(
      /(\s+(Corp(oration)?|Inc|Co|Ltd|Limited|Holdings?|Group|PLC|NV|N\.V\.|SA|S\.A\.|AG|SE|SpA|ASA|AB|Company|Incorporated|K\.K\.)\.?)+$/i,
      "",
    )
    .trim();
}

async function leaderHeadlines(
  market: string,
  name: string,
  sinceMs: number,
  untilMs: number,
): Promise<string[]> {
  const q = market.startsWith("kr-") ? name : leaderSearchName(name);
  if (q.length < 2) return [];
  const needle = q.replace(/\s+/g, "").toLowerCase();
  const hit = (title: string) => {
    if (NOISE_RE.test(title)) return false;
    const t = title.replace(/\s+/g, "").toLowerCase();
    // 종목명 뒤에 다른 글자가 붙은 다른 회사("에스엠" vs "에스엠국일")는 제외 —
    // 한글 조사(은·는·이·가 …)나 문장부호가 오는 경우만 같은 종목으로 본다.
    for (let at = t.indexOf(needle); at >= 0; at = t.indexOf(needle, at + 1)) {
      const next = t.slice(at + needle.length, at + needle.length + 1);
      if (!next || !/[가-힣a-z0-9]/.test(next) || /[은는이가을를의도과와에로만]/.test(next)) return true;
    }
    return false;
  };
  if (market.startsWith("kr-")) {
    const items = await fetchNaverNewsInRange(q, sinceMs, untilMs, { maxPages: 1, perPage: 30 }).catch(() => []);
    return items
      .filter((n) => hit(n.title))
      .slice(0, PER_LEADER)
      .map((n) => `${n.title} (${n.source}, ${n.publishedAt.slice(0, 10)})`);
  }
  const items = await fetchGoogleNewsRss(
    googleNewsUrl(`search?q=${encodeURIComponent(`"${q}"`)}+when:10d`, "hl=en-US&gl=US&ceid=US:en"),
  ).catch(() => []);
  return items
    .filter((n) => {
      const ms = Date.parse(n.publishedAt);
      return Number.isFinite(ms) && ms >= sinceMs && ms <= untilMs && hit(n.title);
    })
    .slice(0, PER_LEADER)
    .map((n) => `${n.title} (${n.source}, ${n.publishedAt.slice(0, 10)})`);
}

/** key = SectorHighlight.id */
export async function buildSectorNews(sectors: WeeklySectors, week: ReportWeek): Promise<Map<string, SectorNews>> {
  // 리포트 주 월요일 0시(KST) ~ 다음 월요일 0시(UTC) — issues.ts 뉴스 집계와 같은 창
  const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
  const untilMs = Date.parse(`${week.weekEnd}T00:00:00Z`) + 3 * 86_400_000;
  const all: SectorHighlight[] = [
    ...sectors.kospi.up, ...sectors.kospi.down,
    ...sectors.kosdaq.up, ...sectors.kosdaq.down,
    ...sectors.us.up, ...sectors.us.down,
    ...sectors.jp.up, ...sectors.jp.down,
    ...sectors.eu.up, ...sectors.eu.down,
  ];
  const out = new Map<string, SectorNews>();
  // 동시에 너무 많이 때리지 않게 섹터 단위로 5개씩
  for (let i = 0; i < all.length; i += 5) {
    await Promise.all(
      all.slice(i, i + 5).map(async (s) => {
        const leaders = (s.leaders ?? []).slice(0, 2);
        const lists = await Promise.all(leaders.map((l) => leaderHeadlines(s.market, l.name, sinceMs, untilMs)));
        out.set(s.id, { headlines: lists.flat() });
      }),
    );
  }
  return out;
}
