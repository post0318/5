import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { SnapshotRow } from "./weekly-reports";
import type { WeeklyIssue } from "@/lib/weekly/issues";
import type { WeeklySectors } from "@/lib/weekly/sectors";
import type { OfficialMetric } from "@/lib/weekly/evidence";
import type { SectorNews } from "@/lib/weekly/sector-news";
import type { ScheduleItem } from "@/lib/weekly/shinhan-schedule";
import type { ReportWeek } from "@/lib/weekly/week";

/**
 * 주간 리포트 입력 묶음(코드 집계 결과) — claude.ai 커넥터(`/api/mcp`)용 보관본(2026-10-10).
 *
 * 커넥터는 "데이터 조회"와 "초안 저장"이 따로 오는데, 저장 때 다시 수집하면 1분 가까이 걸리고
 * Claude 가 읽은 것과 숫자가 달라질 수 있다. 그래서 수집 결과를 주당 1건 저장해 두 단계가 같은
 * 입력을 쓰게 한다. 월요일 자동 초안(generate)도 같은 문서를 채운다. 원문 코퍼스는 없고
 * 이슈별 근거 12건·뉴스 5건 수준이라 주당 수백 KB 이하, 60일 뒤 지운다(TTL).
 */
export interface WeeklyInputsDoc {
  _id: string; // weekStart
  week: ReportWeek;
  collectedAt: Date;
  snapshot: SnapshotRow[];
  all: WeeklyIssue[];
  top: WeeklyIssue[];
  sectors: WeeklySectors;
  official: OfficialMetric[];
  sectorNews: Record<string, SectorNews>;
  schedule: ScheduleItem[];
  codeCalendar: { date: string; event: string }[];
  notes: Record<string, string>;
}

async function col(): Promise<Collection<WeeklyInputsDoc>> {
  const db = await getDb();
  const c = db.collection<WeeklyInputsDoc>("weekly_inputs");
  await c.createIndex({ collectedAt: 1 }, { expireAfterSeconds: 60 * 86_400 }).catch(() => {});
  return c;
}

export async function saveWeeklyInputs(doc: WeeklyInputsDoc): Promise<void> {
  const c = await col();
  await c.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function getWeeklyInputs(weekStart: string): Promise<WeeklyInputsDoc | null> {
  const c = await col();
  return c.findOne({ _id: weekStart });
}
