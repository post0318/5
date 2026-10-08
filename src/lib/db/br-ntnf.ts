import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { NtnfPoint, NtnfSrc } from "@/lib/weekly/ntnf";

/**
 * 브라질 국채 NTN-F ~10년 롤링 수익률(중간값) 일별 값(2026-10-06 — 4번 프로젝트 JSON 대신 5번이 직접 수집, 정의는 ../weekly/ntnf.ts).
 * 쓰기: 1호기 타이머 `macro-br-ntnf`(scripts/run/ntnf-daily.mts).
 *   - 재무부 CSV 중간값(src csv-mid·csv-sell)은 **없는 날짜만** 넣는다.
 *   - ANBIMA 지표(src anbima)는 아직 anbima 가 아닌 날짜에만 쓴다(CSV 값을 대체 — 4번과 같은 우선순위). anbima 값은 바꾸지 않는다.
 * 읽기: 주간 리포트 스냅샷(`weekly/snapshot.ts`). 실시간 임시값은 저장하지 않는다(확정 자료만).
 * 용량: 브라질 영업일 1행(~160B) — 7년 백필 약 1,750행 ≈ 0.3MB(인덱스 포함), 이후 연 약 250행(≈ 40KB). 보존 기한 없음(시계열).
 */
export interface BrNtnfDoc {
  _id: string; // 기준일 YYYY-MM-DD
  ytm: number; // 중간값, %
  maturityYear: number;
  maturityDate: string;
  src: NtnfSrc;
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

/** from 이후 ANBIMA 값이 이미 있는 날짜 */
export async function brNtnfAnbimaDates(from: string): Promise<Set<string>> {
  const docs = await (await brNtnfCol()).find({ _id: { $gte: from }, src: "anbima" }, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((d) => d._id));
}

const fields = (p: NtnfPoint, now: string) => ({ ytm: p.ytm, maturityYear: p.maturityYear, maturityDate: p.maturityDate, src: p.src, fetchedAt: now });

/** CSV 값: 없는 날짜만 넣는다. 새로 들어간 개수 */
export async function insertNewBrNtnf(points: NtnfPoint[]): Promise<number> {
  if (!points.length) return 0;
  const now = new Date().toISOString();
  const r = await (await brNtnfCol()).bulkWrite(
    points.map((p) => ({ updateOne: { filter: { _id: p.date }, update: { $setOnInsert: fields(p, now) }, upsert: true } })),
    { ordered: false },
  );
  return r.upsertedCount;
}

/** ANBIMA 값: 호출자가 anbima 가 아닌 날짜만 넘긴다(brNtnfAnbimaDates 로 거름). 넣거나 CSV 값을 대체한 개수 */
export async function putAnbimaBrNtnf(points: NtnfPoint[]): Promise<number> {
  const list = points.filter((p) => p.src === "anbima");
  if (!list.length) return 0;
  const now = new Date().toISOString();
  const r = await (await brNtnfCol()).bulkWrite(
    list.map((p) => ({ updateOne: { filter: { _id: p.date }, update: { $set: fields(p, now) }, upsert: true } })),
    { ordered: false },
  );
  return r.upsertedCount + r.modifiedCount;
}

/** from~to(포함) 기간 값, 날짜 오름차순 */
export async function getBrNtnfRange(from: string, to: string): Promise<BrNtnfDoc[]> {
  return (await brNtnfCol()).find({ _id: { $gte: from, $lte: to } }).sort({ _id: 1 }).toArray();
}
