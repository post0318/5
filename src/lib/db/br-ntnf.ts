import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { NtnfPoint } from "@/lib/weekly/ntnf";

/**
 * 브라질 국채 NTN-F ~10년 롤링 수익률 일별 값(2026-10-06 — 4번 프로젝트 JSON 대신 5번이 직접 수집).
 * 쓰기: 1호기 타이머 `macro-br-ntnf`(scripts/run/ntnf-daily.mts) — **새 날짜만** 넣는다(이미 있는 날짜는 건드리지 않음).
 * 읽기: 주간 리포트 스냅샷(`weekly/snapshot.ts`).
 * 용량: 브라질 영업일 1행(~150B) — 7년 백필 약 1,750행 ≈ 0.3MB(인덱스 포함), 이후 연 약 250행(≈ 40KB). 보존 기한 없음(차트·비교용 시계열).
 */
export interface BrNtnfDoc {
  _id: string; // 기준일 YYYY-MM-DD
  ytm: number; // Taxa Venda, %
  maturityYear: number;
  maturityDate: string;
  source: "tesouro-csv";
  fetchedAt: string; // ISO
}

export async function brNtnfCol(): Promise<Collection<BrNtnfDoc>> {
  return (await getDb()).collection<BrNtnfDoc>("br_ntnf_daily");
}

/** 저장된 가장 최근 기준일(없으면 null) */
export async function latestBrNtnfDate(): Promise<string | null> {
  const d = await (await brNtnfCol()).find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next();
  return d?._id ?? null;
}

/** 없는 날짜만 넣는다. 새로 들어간 개수를 돌려준다. */
export async function insertNewBrNtnf(points: NtnfPoint[]): Promise<number> {
  if (!points.length) return 0;
  const now = new Date().toISOString();
  const r = await (await brNtnfCol()).bulkWrite(
    points.map((p) => ({
      updateOne: {
        filter: { _id: p.date },
        update: {
          $setOnInsert: { ytm: p.ytm, maturityYear: p.maturityYear, maturityDate: p.maturityDate, source: "tesouro-csv" as const, fetchedAt: now },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return r.upsertedCount;
}

/** from~to(포함) 기간 값, 날짜 오름차순 */
export async function getBrNtnfRange(from: string, to: string): Promise<BrNtnfDoc[]> {
  return (await brNtnfCol()).find({ _id: { $gte: from, $lte: to } }).sort({ _id: 1 }).toArray();
}
