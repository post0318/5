import type { ObjectId } from "mongodb";

/**
 * 유니버스 종목 (prd.md §5.4) — MongoDB `universe_items` 컬렉션.
 */
export interface UniverseItemDoc {
  _id?: ObjectId;
  /** "kr" | "us" | "jp" */
  market: string;
  /** 시장별 정규화 심볼 */
  symbol: string;
  name: string | null;
  /** Yahoo 심볼 오버라이드 (KOSDAQ .KQ 등) */
  yahooSymbol: string | null;
  /** 분류 그룹 */
  groupName: string | null;
  tags: string[];
  active: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** API 응답용 (id = ObjectId hex 문자열) */
export interface UniverseItem {
  id: string;
  market: string;
  symbol: string;
  name: string | null;
  yahooSymbol: string | null;
  groupName: string | null;
  tags: string[];
  active: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
