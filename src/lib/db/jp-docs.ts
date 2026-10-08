import "server-only";
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import { getDb } from "./index";
import { edinetDayList, isFinalDate, LIST_FIELDS, recentDates, type EdinetDoc } from "@/lib/markets/jp/edinet-store";

/**
 * **일본 재무 보고서 색인**(오너 결정 2026-10-08 — 원본은 디스크, DB 는 작은 색인만. 운영 Atlas M0 512MB).
 * EDINET 은 날짜별 목록만 있고 회사별 조회가 없다 — 예전엔 화면마다 400일치 documents.json 을 훑었다(25~44초). 날짜 목록(디스크,
 * edinet-store.ts)에서 **상장사(secCode 있음)의 재무 보고서만** 골라 여기 둔다.
 *  - jp_docs       _id = docID. 서류 종류 120·130·140·150·160·170(有報·訂正有報·四半期·訂正四半期·半期·訂正半期). 목록 칸(LIST_FIELDS) 중
 *                  null 칸·fundCode(상장사 재무 보고서엔 없음)는 뺀다. 한 건 ≈ 0.3~0.4KB.
 *  - jp_docs_days  _id = 날짜(JST). count(그날 목록 전체 건수)·reports(색인한 건수)·final(확정일 — 다시 안 받음)·at(색인 시각).
 * docID 는 바뀌지 않는다(정정은 새 docID). 다만 取下げ(withdrawalStatus "1")는 뒤 날짜 목록에 같은 docID 로 다시 나온다 — 取下げ 표시는
 * 덮어쓰고, 그 밖의 칸은 처음 넣을 때만 쓴다(옛 날짜를 나중에 색인해도 取下げ 표시가 되돌아가지 않게).
 */

export const JP_REPORT_TYPES = ["120", "130", "140", "150", "160", "170"] as const;
const REPORT_SET = new Set<string>(JP_REPORT_TYPES);
/** 최근 날짜(확정 전) 재색인 간격 — 이보다 최근에 색인했으면 다시 받지 않는다 */
const RECENT_REINDEX_MS = 30 * 60_000;

export type JpDocRow = Partial<Omit<EdinetDoc, "docID" | "fundCode">> & { _id: string };
export interface JpDocDay {
  _id: string;
  count: number;
  reports: number;
  final: boolean;
  at: Date;
}

let indexed = false;
export async function jpDocsCol(): Promise<Collection<JpDocRow>> {
  const col = (await getDb()).collection<JpDocRow>("jp_docs");
  if (!indexed) {
    // 같은 정의면 아무 일도 하지 않는다(idempotent). 실패는 그대로 던진다
    await col.createIndex({ edinetCode: 1, submitDateTime: -1 });
    await col.createIndex({ secCode: 1 });
    indexed = true;
  }
  return col;
}
export async function jpDocsDaysCol(): Promise<Collection<JpDocDay>> {
  return (await getDb()).collection<JpDocDay>("jp_docs_days");
}

/** 목록 한 줄 → 색인 대상이면 저장 꼴, 아니면 null */
export function toJpDocRow(d: EdinetDoc): JpDocRow | null {
  if (!d.secCode || !d.docTypeCode || !REPORT_SET.has(d.docTypeCode)) {
    // 取下げ된 서류는 목록에서 secCode·docTypeCode 가 비어 나오기도 한다 — 이미 색인된 docID 의 取下げ 표시용으로만 따로 처리
    return null;
  }
  const o: Record<string, string> = { _id: d.docID };
  for (const k of LIST_FIELDS) {
    if (k === "docID" || k === "fundCode") continue;
    const v = d[k];
    if (v != null) o[k] = v;
  }
  return o as JpDocRow;
}

/** 그날 목록 하나를 색인 — 반환: 그날 전체 건수·색인 건수 */
async function indexOneDay(date: string): Promise<{ date: string; count: number; reports: number; final: boolean }> {
  const list = await edinetDayList(date);
  const ops: AnyBulkWriteOperation<JpDocRow>[] = [];
  const withdrawn: string[] = [];
  for (const d of list) {
    if (d.withdrawalStatus === "1") withdrawn.push(d.docID);
    const row = toJpDocRow(d);
    if (!row) continue;
    const { _id, withdrawalStatus, ...rest } = row;
    ops.push({
      updateOne: {
        filter: { _id },
        update:
          withdrawalStatus === "1"
            ? { $set: { withdrawalStatus: "1" }, $setOnInsert: rest }
            : { $setOnInsert: { ...rest, ...(withdrawalStatus ? { withdrawalStatus } : {}) } },
        upsert: true,
      },
    });
  }
  const col = await jpDocsCol();
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  // 取下げ 줄이 칸을 비운 채 나와 색인 대상에서 빠진 경우 — 이미 있는 문서에만 표시(새로 만들지 않음)
  if (withdrawn.length) await col.updateMany({ _id: { $in: withdrawn } }, { $set: { withdrawalStatus: "1" } });
  const final = isFinalDate(date);
  await (await jpDocsDaysCol()).replaceOne(
    { _id: date },
    { count: list.length, reports: ops.length, final, at: new Date() },
    { upsert: true },
  );
  return { date, count: list.length, reports: ops.length, final };
}

/** 주어진 날짜들을 차례로 색인(목록은 edinet-store 디스크 캐시 경유). 실패는 그대로 던진다 */
export async function indexEdinetDays(dates: string[]): Promise<{ date: string; count: number; reports: number; final: boolean }[]> {
  const out = [];
  for (const d of dates) out.push(await indexOneDay(d));
  return out;
}

export interface EnsureIndexedResult {
  /** 이번에 새로 색인한 날 */
  fetched: string[];
  /** maxFetch 한도로 이번에 못 한 날(최신순) — 배치(scripts/run/jp-edinet-index.mts)가 채운다 */
  pending: string[];
  /** 색인 실패한 날과 사유 */
  failed: { date: string; error: string }[];
}

/**
 * 최근 days 일 중 확정 색인이 안 된 날을 색인(최신순, 한 번에 maxFetch 일까지 — 화면 요청이 수백 번 받지 않게).
 * 확정 전 날(최근 이틀)은 30분에 한 번만 다시 받는다. 날짜별 실패는 failed 에 모아 돌려준다(호출자가 결과 완전성을 판정 — 조용히 버리지 않는다).
 * DB 조회 실패는 던진다.
 */
export async function ensureIndexed(opts: { days: number; maxFetch?: number }): Promise<EnsureIndexedResult> {
  const dates = recentDates(opts.days);
  const maxFetch = opts.maxFetch ?? 20;
  const seen = await (await jpDocsDaysCol())
    .find({ _id: { $in: dates } }, { projection: { final: 1, at: 1 } })
    .toArray();
  const byId = new Map(seen.map((d) => [d._id, d]));
  const todo = dates.filter((d) => {
    const s = byId.get(d);
    if (!s) return true;
    if (s.final) return false;
    // 색인 당시엔 확정 전이었지만 지금은 확정일 → 한 번 더 받아 확정으로 표시
    if (isFinalDate(d)) return true;
    return Date.now() - new Date(s.at).getTime() > RECENT_REINDEX_MS;
  });
  const res: EnsureIndexedResult = { fetched: [], pending: todo.slice(maxFetch), failed: [] };
  for (const d of todo.slice(0, maxFetch)) {
    try {
      await indexOneDay(d);
      res.fetched.push(d);
    } catch (e) {
      res.failed.push({ date: d, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return res;
}

/** 회사(EDINET 코드)의 재무 보고서 — 최신 제출순. 取下げ 제외. types 없으면 6종 전부 */
export async function listJpReports(edinetCode: string, types?: readonly string[]): Promise<JpDocRow[]> {
  const col = await jpDocsCol();
  return col
    .find({
      edinetCode,
      withdrawalStatus: { $ne: "1" },
      ...(types?.length ? { docTypeCode: { $in: [...types] } } : {}),
    })
    .sort({ submitDateTime: -1 })
    .toArray();
}
