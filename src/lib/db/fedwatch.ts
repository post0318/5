import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { FedWatch } from "@/lib/macro/fedwatch";

/**
 * Fed 금리 확률(Kalshi) 일별 스냅샷 — CME FedWatch·investing.com 이 보여주는
 * "현재/전일/전주" 비교(오너 지시 2026-09-20)를 위해 하루 1회 저장한다.
 * `fedwatch_daily`: 문서당 하루, `_id`=수집일(YYYY-MM-DD, UTC).
 */

export interface FedWatchDailyDoc {
  _id: string; // 수집일 YYYY-MM-DD (UTC)
  meetingDate: string;
  meetingLabel: string;
  hikeProb: number;
  holdProb: number;
  cutProb: number;
  buckets: { label: string; prob: number; isCurrent: boolean }[];
  asOf: string;
}

export async function fedWatchDailyCol(): Promise<Collection<FedWatchDailyDoc>> {
  return (await getDb()).collection<FedWatchDailyDoc>("fedwatch_daily");
}

export async function saveFedWatchSnapshot(fw: FedWatch): Promise<void> {
  const col = await fedWatchDailyCol();
  const id = new Date().toISOString().slice(0, 10);
  const doc: FedWatchDailyDoc = {
    _id: id,
    meetingDate: fw.meetingDate,
    meetingLabel: fw.meetingLabel,
    hikeProb: fw.hikeProb,
    holdProb: fw.holdProb,
    cutProb: fw.cutProb,
    buckets: fw.buckets,
    asOf: fw.asOf,
  };
  await col.updateOne({ _id: id }, { $set: doc }, { upsert: true });
}

async function nearestOnOrBefore(dateIso: string): Promise<FedWatchDailyDoc | null> {
  const col = await fedWatchDailyCol();
  return col.find({ _id: { $lte: dateIso } }).sort({ _id: -1 }).limit(1).next();
}

export interface FedWatchComparison {
  yesterday: FedWatchDailyDoc | null;
  weekAgo: FedWatchDailyDoc | null;
}

/**
 * 전일·전주 스냅샷 조회 — FOMC 회의가 그 사이 지나 "다음 회의"가 바뀌면
 * 비교 자체가 무의미해지므로 `currentMeetingDate` 가 다르면 버린다(null).
 */
export async function getFedWatchComparison(currentMeetingDate: string): Promise<FedWatchComparison> {
  const now = new Date();
  const y = new Date(now);
  y.setUTCDate(y.getUTCDate() - 1);
  const w = new Date(now);
  w.setUTCDate(w.getUTCDate() - 7);
  const [yesterday, weekAgo] = await Promise.all([
    nearestOnOrBefore(y.toISOString().slice(0, 10)),
    nearestOnOrBefore(w.toISOString().slice(0, 10)),
  ]);
  const sameMeeting = (d: FedWatchDailyDoc | null) =>
    d && d.meetingDate === currentMeetingDate ? d : null;
  return { yesterday: sameMeeting(yesterday), weekAgo: sameMeeting(weekAgo) };
}
