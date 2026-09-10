import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { ClassAFacts, ClassAYear } from "@/lib/markets/us/edgar-classfacts";

/**
 * 듀얼클래스 종목(Visa 등)의 Class A EPS·가중평균주식수 캐시.
 * companyfacts 에 없는 값이라 10-K XBRL 인스턴스를 파싱해 채운다 (cron 분기 갱신).
 * 종목·연도당 숫자 4개뿐 → 컬렉션 전체가 수 KB.
 */
export interface UsClassFactsDoc {
  _id: string; // "{cik10}:{fy}"
  cik: string; // 10자리
  fy: number;
  endDate: string;
  epsDiluted: number | null;
  epsBasic: number | null;
  dilShares: number | null;
  basicShares: number | null;
  sourceAccn: string;
  updatedAt: string;
}

export async function usClassFactsCol(): Promise<Collection<UsClassFactsDoc>> {
  const col = (await getDb()).collection<UsClassFactsDoc>("us_class_facts");
  await col.createIndex({ cik: 1 }).catch(() => {});
  return col;
}

const cik10 = (cik: string | number) => String(cik).replace(/\D/g, "").padStart(10, "0");

/** DB 에서 cik 의 Class A 시계열. 없으면 null. */
export async function getClassAFactsFromDb(cik: string | number): Promise<ClassAFacts | null> {
  try {
    const col = await usClassFactsCol();
    const docs = await col.find({ cik: cik10(cik) }).toArray();
    if (!docs.length) return null;
    const out: ClassAFacts = new Map();
    for (const d of docs) {
      const y: ClassAYear = {
        fy: d.fy,
        endDate: d.endDate,
        epsDiluted: d.epsDiluted,
        epsBasic: d.epsBasic,
        dilShares: d.dilShares,
        basicShares: d.basicShares,
        sourceAccn: d.sourceAccn,
      };
      out.set(d.fy, y);
    }
    return out;
  } catch {
    return null;
  }
}

/** 파싱한 시계열을 DB 에 upsert. 반환 = 기록한 연도 수. */
export async function saveClassAFactsToDb(
  cik: string | number,
  cf: ClassAFacts,
): Promise<number> {
  const col = await usClassFactsCol();
  const now = new Date().toISOString();
  const c = cik10(cik);
  const ops = [...cf.values()].map((y) => ({
    updateOne: {
      filter: { _id: `${c}:${y.fy}` },
      update: {
        $set: {
          cik: c,
          fy: y.fy,
          endDate: y.endDate,
          epsDiluted: y.epsDiluted,
          epsBasic: y.epsBasic,
          dilShares: y.dilShares,
          basicShares: y.basicShares,
          sourceAccn: y.sourceAccn,
          updatedAt: now,
        },
      },
      upsert: true,
    },
  }));
  if (!ops.length) return 0;
  await col.bulkWrite(ops, { ordered: false });
  return ops.length;
}
