import type { ObjectId } from "mongodb";

/**
 * 유니버스 종목 (prd.md §5.4) — MongoDB `universe_items` 컬렉션.
 *
 * 유니버스는 계정별로 완전히 분리된다(2026-09, 오너 지시). 유일 키가
 * (ownerId, market, symbol) 이라 같은 종목을 여러 사람이 각자의 그룹명·태그·
 * 메모로 담을 수 있다. 시세·멀티플은 사람과 무관하므로 `universe_overview`
 * 캐시만 (market, symbol) 로 공유한다 — 같은 종목을 열 사람이 담아도 외부
 * API 호출은 한 번이다.
 */
export interface UniverseItemDoc {
  _id?: ObjectId;
  /**
   * 소유 계정(Clerk userId). Clerk 도입 이전에 만들어진 문서는 이 필드가
   * 없다 — 관리자가 「기존 유니버스 가져오기」로 자기 계정에 귀속시킨다.
   */
  ownerId?: string;
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
  ownerId: string | null;
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
