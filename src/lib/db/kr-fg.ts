import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 한국판 공포·탐욕 지수 저장소 (MongoDB M0 무료 범위).
 *  - kr_fg_daily     : 거래일별 원자료 스냅샷 1문서 (영구 보관, 문서당 ~250B)
 *  - kr_stock_roll   : 종목별 최근 252거래일 종가 롤링 창 (52주 신고/신저 판정용)
 */

export interface KrFgDailyDoc {
  _id: string; // 거래일 YYYY-MM-DD
  kospiClose: number | null;
  advancers: number | null;
  decliners: number | null;
  unchanged: number | null;
  upVolume: number | null; // 상승 종목 거래량 합
  downVolume: number | null; // 하락 종목 거래량 합
  newHigh52: number | null; // 52주 신고가 종목 수
  newLow52: number | null; // 52주 신저가 종목 수
  totalWithHistory: number | null; // 52주 판정 대상 종목 수 (분모)
  vkospi: number | null;
  gov3y: number | null;
  gov10y: number | null;
  corpAA: number | null;
  corpBBB: number | null;
  putCall: number | null; // 거래량 기준 (참고)
  putCallVal: number | null; // 거래대금 기준 (점수 산출에 사용)
  foreignFutNet: number | null; // 외국인 KOSPI200 선물 순매수(계약수, 일별) — 수동 업로드
  futBasis: number | null; // 코스피200 선물(근월물) 종가 − 현물 스프레드 (콘탱고 +/백워데이션 -)
  closed?: boolean; // 휴장일 확인 마커(전종목 데이터 없음) — 백필 재시도 무한루프 방지용
  updatedAt: string;
}

export interface KrStockRollDoc {
  _id: string; // 종목코드
  // 최근 252 거래일 종가 (오래된 것 → 최신). 길이 유지.
  closes: number[];
  lastDate: string;
}

export async function krFgDailyCol(): Promise<Collection<KrFgDailyDoc>> {
  const col = (await getDb()).collection<KrFgDailyDoc>("kr_fg_daily");
  return col;
}

export async function krStockRollCol(): Promise<Collection<KrStockRollDoc>> {
  const col = (await getDb()).collection<KrStockRollDoc>("kr_stock_roll");
  return col;
}

interface KrMetaDoc {
  _id: string;
  value: string;
}
export async function getMeta(key: string): Promise<string | null> {
  const col = (await getDb()).collection<KrMetaDoc>("kr_fg_meta");
  const d = await col.findOne({ _id: key });
  return d?.value ?? null;
}
export async function setMeta(key: string, value: string): Promise<void> {
  const col = (await getDb()).collection<KrMetaDoc>("kr_fg_meta");
  await col.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
}

/**
 * 쿨다운 락을 원자적으로 획득. `key` 문서가 없거나 `value`(ms epoch)가
 * cooldownMs 이전이면 now 로 갱신하고 true, 그 외(쿨다운 중)엔 false.
 * getMeta 로 읽고 setMeta 로 쓰는 두 단계로는 동시 요청 시 둘 다 통과하는
 * race 가 있어(2026-09 발견) findOneAndUpdate 단일 원자 연산으로 대체.
 */
export async function tryAcquireCooldown(key: string, cooldownMs: number): Promise<boolean> {
  const col = (await getDb()).collection<KrMetaDoc>("kr_fg_meta");
  const now = Date.now();
  const cutoff = String(now - cooldownMs);
  try {
    await col.findOneAndUpdate(
      { _id: key, $or: [{ value: { $exists: false } }, { value: { $lt: cutoff } }] },
      { $set: { value: String(now) } },
      { upsert: true },
    );
    return true;
  } catch {
    // _id 는 있지만 필터($or)에 안 걸림 → upsert 가 시도한 insert 가 중복키 에러
    // = 쿨다운 중이라는 뜻(락 획득 실패). 다른 원인의 에러도 안전 측(락 없음)으로 처리.
    return false;
  }
}

export async function getKrFgHistory(limitDays = 260 * 6): Promise<KrFgDailyDoc[]> {
  const col = await krFgDailyCol();
  // 컬렉션 전체를 읽어 JS 에서 slice(-limitDays) 하던 것을 DB 단에서
  // sort+limit 하도록 변경 — 문서가 늘어날수록(영구 보관 컬렉션) 매 호출이
  // 필요 이상으로 전체를 실어 나르던 비용 제거 (2026-09 수정)
  const docs = await col.find({}).sort({ _id: -1 }).limit(limitDays).toArray();
  return docs.reverse();
}
