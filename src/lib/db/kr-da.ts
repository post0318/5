import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 한국 종목 감가상각비·무형자산상각비 (연결, DART XBRL 주석 파싱 결과).
 * OpenDART XBRL 엔드포인트가 클라우드 IP를 차단해 Vercel 실시간 조회 불가 →
 * 외부(로컬)에서 파싱해 MongoDB 에 적재, 조회는 DB 우선.
 * `scripts/populate-kr-da.mjs` (분기·반기 보고서 시즌마다 재실행).
 */
export interface KrDaDoc {
  _id: string; // 종목코드
  /** 연도 → {감가상각비, 무형자산상각비} (원) */
  byYear: Record<string, { depreciation: number | null; amortisation: number | null }>;
  updatedAt: string;

  // ── 레거시(단일연도) — 마이그레이션 전 문서 호환 ──
  year?: number;
  depreciation?: number | null;
  amortisation?: number | null;
  basis?: "ttm" | "annual";
  label?: string;
  ttmDepreciation?: number | null;
  ttmAmortisation?: number | null;
  ttmLabel?: string | null;
  /**
   * 리스부채 주석(오너 결정 2026-10-05 — 재무상태표 본표에 리스부채 줄이 없으면 주석의 리스부채 합계를 총차입금에 넣는다).
   * 열쇠 = 사업연도("2025"). 본표에 리스부채 줄이 있는 회사·해는 적재하지 않는다(본표가 기준). populate-kr-da.mjs 가 사업보고서 XBRL 주석·
   * 회계정책 문장에서 만든다.
   *  - included: 회계정책이 리스부채를 본표 차입금 줄에 포함한다고 밝힘(삼성전자 "'유동성장기부채' 또는 '장기차입금'으로 분류") — 더하지 않음
   *  - added: 주석 리스부채 장부금액(태그 꼴 두 개 이상 일치)을 총차입금에 더함
   *  - unknown: 둘 다 못 정함 — EV 공란 + 사유
   */
  leaseNote?: Record<string, KrLeaseNote>;
  /** 분기 보고서 기준(LTM) 판정 — 분기 보고서 XBRL 은 주석을 태깅하지 않아 금액은 못 구한다. 최근 사업보고서 회계정책이 "포함"이면 included */
  leasePolicyLatest?: KrLeaseNote | null;
}

export interface KrLeaseNote {
  status: "included" | "added" | "unknown";
  amount: number | null;
  /** 근거(접수번호·태그 꼴·정책 문장) — 화면 주석에 그대로 */
  how: string;
}

export async function krDaCol(): Promise<Collection<KrDaDoc>> {
  // 로컬 시험은 KR_DA_COLLECTION=kr_da_staging — 로컬과 운영이 같은 DB 라 브랜치 작업의 적재가 운영에 바로 섞이지 않게(오너 지시 2026-10-02
  // "한국은 브랜치로 커밋, 마스터는 다 확인하고 배포")
  return (await getDb()).collection<KrDaDoc>(process.env.KR_DA_COLLECTION || "kr_da");
}

/**
 * 적재본 조회. **DB 조회 실패는 던진다**(감사 1차 ⑥ — 예전엔 null 로 삼켜 화면이 "주석 미적재 … 빈칸" 정상 문구를 띄웠다). 문서가 없을
 * 때만 null. 호출부는 getKrDaDocChecked 로 받아 실패를 "⚠ 감가상각비 조회 실패" 경고로 남기고 캐시하지 않는다.
 */
export async function getKrDaDoc(symbol: string): Promise<KrDaDoc | null> {
  const col = await krDaCol();
  const doc = await col.findOne({ _id: symbol });
  if (!doc) return null;
  // 레거시 문서(byYear 없음) → 단일연도를 byYear 로 승격
  if (!doc.byYear && doc.year != null) {
    doc.byYear = { [doc.year]: { depreciation: doc.depreciation ?? null, amortisation: doc.amortisation ?? null } };
  }
  return doc;
}

/** getKrDaDoc + 실패 사유 — 실패면 doc null·warning 문구(화면 주석·응답에 실어 검증기 조회 실패 경고로 잡히게) */
export async function getKrDaDocChecked(symbol: string): Promise<{ doc: KrDaDoc | null; warning: string | null }> {
  try {
    return { doc: await getKrDaDoc(symbol), warning: null };
  } catch (e) {
    return { doc: null, warning: `감가상각비 조회 실패(적재본 DB) — ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
}

export async function putKrDaDoc(doc: KrDaDoc): Promise<void> {
  const col = await krDaCol();
  await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
}
