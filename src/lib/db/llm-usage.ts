import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * LLM(번역·요약) 호출 월별 누적 비용. 종목뉴스 기능 전용 — 다른 LLM 용도가
 * 생기면 별도 컬렉션으로 분리할 것 (이 카운터는 이 기능의 예산만 추적).
 */
export interface LlmUsageDoc {
  _id: string; // "YYYY-MM"
  totalCostUsd: number;
  callCount: number;
  alertSentAt: string | null;
}

export const MONTHLY_BUDGET_USD = 10;

function currentMonthId(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function llmUsageCol(): Promise<Collection<LlmUsageDoc>> {
  const db = await getDb();
  return db.collection<LlmUsageDoc>("llm_usage");
}

export async function getMonthUsage(): Promise<LlmUsageDoc> {
  const col = await llmUsageCol();
  const _id = currentMonthId();
  const doc = await col.findOne({ _id });
  return doc ?? { _id, totalCostUsd: 0, callCount: 0, alertSentAt: null };
}

export async function isBudgetExceeded(): Promise<boolean> {
  const usage = await getMonthUsage();
  return usage.totalCostUsd >= MONTHLY_BUDGET_USD;
}

/** 호출 성공 후 실비용 가산 (원자적). */
export async function incUsage(costUsd: number): Promise<void> {
  const col = await llmUsageCol();
  const _id = currentMonthId();
  await col.updateOne(
    { _id },
    { $inc: { totalCostUsd: costUsd, callCount: 1 }, $setOnInsert: { alertSentAt: null } },
    { upsert: true },
  );
}

/** 이번 달 아직 알림 안 보냈으면 true 반환하며 발송 표시(중복 발송 방지). */
export async function claimAlertSlot(): Promise<boolean> {
  const col = await llmUsageCol();
  const _id = currentMonthId();
  const res = await col.updateOne(
    { _id, alertSentAt: null },
    { $set: { alertSentAt: new Date().toISOString() } },
  );
  return res.modifiedCount > 0;
}
