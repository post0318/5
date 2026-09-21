import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 주제별 주간 집계 보관(오너 지시 2026-09-21).
 *
 * 왜 필요한가 — 지금 이슈 점수는 주제별 건수를 **전 주제 최댓값**으로 나눈다.
 * 그러면 검색어가 원래 많은 기사를 주는 주제가 항상 유리하다(실측 2026-09-21:
 * 미국 금리 319건 / 고용·경기 4건 → 고용은 점수 0.01 수준으로 영구 배제).
 * 기사량 차이는 "그 주에 무슨 일이 있었나"가 아니라 검색어가 주는 양의 차이다.
 *
 * 고치려면 "그 주제의 평소 대비 배수"가 필요한데, **과거를 역으로 조회할 수
 * 없다** — 네이버 뉴스 검색은 최신순이라 3주 전에 닿으려면 수백 페이지를
 * 넘겨야 하고 API 상한(start ≤ 1000)에 먼저 걸린다. 실측으로 확인했다
 * (기준선이 전부 0 으로 나옴). 그래서 **앞으로 쌓는다**.
 *
 * 리포트를 만들 때마다 주제별 건수를 남기고, 몇 주 지나면 그 평균을 기준선
 * 으로 쓴다. 저장은 문서 하나 upsert 라 비용이 없다.
 */

export interface WeeklyTopicCountsDoc {
  /** 리포트 대상 주 월요일 YYYY-MM-DD */
  _id: string;
  /** 주제 라벨 → 그 주 집계 */
  counts: Record<string, { research: number; news: number; search: number | null }>;
  savedAt: string;
}

export async function weeklyTopicCountsCol(): Promise<Collection<WeeklyTopicCountsDoc>> {
  return (await getDb()).collection<WeeklyTopicCountsDoc>("weekly_topic_counts");
}

/** 리포트 생성 때마다 그 주 집계를 덮어쓴다(재생성하면 최신 값으로). */
export async function saveWeeklyTopicCounts(
  weekStart: string,
  rows: { label: string; researchCount: number; newsCount: number; searchInterest: number | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  const counts: WeeklyTopicCountsDoc["counts"] = {};
  for (const r of rows) {
    counts[r.label] = { research: r.researchCount, news: r.newsCount, search: r.searchInterest };
  }
  const col = await weeklyTopicCountsCol();
  await col.updateOne(
    { _id: weekStart },
    { $set: { counts, savedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

export interface TopicBaseline {
  /** 기준선 계산에 실제로 쓰인 주 수 — 0 이면 아직 못 쓴다 */
  weeks: number;
  /** 주제 라벨 → 직전 N주 평균 */
  mean: Map<string, { research: number; news: number; search: number | null }>;
}

/**
 * `beforeWeekStart` **이전** 최대 N주의 평균. 해당 주 자신은 제외한다 —
 * 기준선에 이번 주가 섞이면 "평소 대비"가 희석된다.
 *
 * 주 수가 부족하면 `weeks` 가 작게 돌아온다. 호출부는 그 값을 보고 기준선을
 * 쓸지(충분히 쌓였는지) 판단한다 — 한두 주 평균은 표본이 너무 적어
 * 노이즈가 그대로 배수로 증폭된다.
 */
export async function getTopicBaseline(beforeWeekStart: string, weeks = 4): Promise<TopicBaseline> {
  const col = await weeklyTopicCountsCol();
  const docs = await col
    .find({ _id: { $lt: beforeWeekStart } })
    .sort({ _id: -1 })
    .limit(weeks)
    .toArray();
  const mean = new Map<string, { research: number; news: number; search: number | null }>();
  if (docs.length === 0) return { weeks: 0, mean };

  const labels = new Set<string>();
  for (const d of docs) for (const l of Object.keys(d.counts)) labels.add(l);
  for (const label of labels) {
    let research = 0;
    let news = 0;
    let searchSum = 0;
    let searchN = 0;
    let seen = 0;
    for (const d of docs) {
      const c = d.counts[label];
      if (!c) continue; // 그 주에 없던 주제(신설 전) — 평균에서 빼야 과소평가가 안 된다
      seen++;
      research += c.research;
      news += c.news;
      if (c.search != null) {
        searchSum += c.search;
        searchN++;
      }
    }
    if (seen === 0) continue;
    mean.set(label, {
      research: research / seen,
      news: news / seen,
      search: searchN > 0 ? searchSum / searchN : null,
    });
  }
  return { weeks: docs.length, mean };
}
