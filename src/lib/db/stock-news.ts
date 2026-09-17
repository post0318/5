import "server-only";
import type { Collection } from "mongodb";
import { getDb, isDbConfigured } from "./index";
import type { NewsItem } from "@/lib/markets/news";

/**
 * 종목뉴스 캐시 — MongoDB 영속화(2026-09-17 추가).
 *
 * 그동안 종목뉴스는 요청이 올 때마다 네이버 태깅(2페이지)·야후·구글뉴스 두
 * 갈래를 긁고 해외 헤드라인을 번역한 뒤 LLM 관련성 판정까지 돌렸다. 실측
 * (로컬 프로덕션 빌드, LLM 미사용 상태) 처음 보는 종목이 4.5~9.3초다. HTTP
 * `s-maxage` CDN 캐시만 있어서 종목을 옮겨 다니면 계속 빈 캐시를 맞는다.
 *
 * 크론이 유니버스 종목을 미리 받아 여기에 넣어두고, 화면은 이 컬렉션을 읽는다.
 * 유니버스 밖 종목만 예전처럼 즉시 조회하고 결과를 함께 저장한다.
 *
 * 용량(실측 8종목 평균): 종목당 47.6KB, 기사 1건당 약 750B.
 * 유니버스 77종목 → 3.6MB, 200종목으로 늘어도 9.3MB. 종목당 문서 하나를
 * 덮어쓰므로 회차를 쌓지 않는다.
 */

export interface StockNewsDoc {
  /** `${market}:${symbol}` — 종목당 한 문서, 갱신 시 덮어쓴다 */
  _id: string;
  market: string;
  symbol: string;
  /** 수집 당시 회사명 — 디버깅·질의어 확인용 */
  companyName: string | null;
  domestic: NewsItem[];
  overseas: NewsItem[];
  /** 관련성 판정 경로("llm" | "no_api_key" | ...) — 진단용 */
  relevance: string;
  /** 원본 후보 건수 — 진단용 */
  rawDomestic: number;
  rawOverseas: number;
  /** 수집 시각 (ISO) — 신선도 판정에 쓴다 */
  fetchedAt: string;
  /** TTL 인덱스 기준. 오래 방치된 종목 문서는 스스로 사라진다 */
  updatedAt: Date;
}

/** 30일간 아무도 안 보고 크론도 안 도는 종목 문서는 지운다 */
const TTL_DAYS = 30;

export function stockNewsKey(market: string, symbol: string): string {
  return `${market}:${symbol}`;
}

let indexReady: Promise<void> | null = null;

export async function stockNewsCol(): Promise<Collection<StockNewsDoc>> {
  const db = await getDb();
  const col = db.collection<StockNewsDoc>("stock_news");
  // 인덱스 생성은 idempotent 하지만 매 요청 호출하면 왕복이 붙는다 — 인스턴스당 1회.
  indexReady ??= col
    .createIndex({ updatedAt: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 })
    .then(() => undefined)
    .catch(() => undefined);
  await indexReady;
  return col;
}

export async function getCachedStockNews(
  market: string,
  symbol: string,
): Promise<StockNewsDoc | null> {
  if (!isDbConfigured()) return null;
  try {
    const col = await stockNewsCol();
    return await col.findOne({ _id: stockNewsKey(market, symbol) });
  } catch {
    // DB 장애로 캐시를 못 읽으면 실시간 조회로 넘어간다 — 뉴스 기능 자체는 산다
    return null;
  }
}

export async function setCachedStockNews(
  doc: Omit<StockNewsDoc, "_id" | "updatedAt">,
): Promise<void> {
  if (!isDbConfigured()) return;
  // 한 건도 못 받았으면 저장하지 않는다 — 일시적 실패를 캐시해 굳히면
  // TTL 이 끝날 때까지 빈 화면이 된다.
  if (doc.domestic.length === 0 && doc.overseas.length === 0) return;
  try {
    const col = await stockNewsCol();
    // replaceOne 의 교체 문서에는 _id 를 넣지 않는다(드라이버 타입이 금지).
    // upsert 로 새로 생길 때는 필터의 _id 가 그대로 쓰인다.
    await col.replaceOne(
      { _id: stockNewsKey(doc.market, doc.symbol) },
      { ...doc, updatedAt: new Date() },
      { upsert: true },
    );
  } catch {
    // 저장 실패는 조용히 무시 — 이번 응답은 이미 만들어져 있다
  }
}

/** 수집 시각으로부터 지난 시간(ms). 문서가 없으면 Infinity */
export function ageMs(doc: StockNewsDoc | null): number {
  if (!doc) return Infinity;
  const t = new Date(doc.fetchedAt).getTime();
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}
