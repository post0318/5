import "server-only";
import { AdapterError } from "../types";

/**
 * 한국은행 ECOS 원/달러 환율(일별) — DART 연결 ADR(us/dart-adr.ts)의 환율 원천.
 *   - reference: 매매기준율(731Y001 · 0000001) — 기간 평균(손익·현금흐름)용 (오너 결정 2026-09-24)
 *   - close: 서울 외환시장 종가 15:30(731Y003 · 0000003) — 시점 값(재무상태표·시가총액)용. 거래일만 있어
 *     "결산일의 마지막 거래일" 값이 된다(오너 결정 2026-09-25 — 인포맥스 기말 환율과 2022 정확 일치,
 *     2021·2023·2024 ±0.05% 안).
 * 실패하면 예외 — 다른 원천(Yahoo)으로 조용히 대체하지 않는다(부르는 쪽이 빈칸/오류 처리).
 */
export interface EcosFxPoint {
  date: string; // YYYY-MM-DD
  /** 원/달러(1달러당 원) */
  krwPerUsd: number;
}

export type EcosFxKind = "reference" | "close";
const SERIES: Record<EcosFxKind, string> = { reference: "731Y001/D/{a}/{b}/0000001", close: "731Y003/D/{a}/{b}/0000003" };

const TTL = 1000 * 60 * 60 * 12;
const cache = new Map<EcosFxKind, { at: number; data: EcosFxPoint[] }>();
const inFlight = new Map<EcosFxKind, Promise<EcosFxPoint[]>>();

async function load(kind: EcosFxKind): Promise<EcosFxPoint[]> {
  const k = process.env.ECOS_API_KEY;
  if (!k) throw new AdapterError("ECOS_API_KEY 미설정 — 원/달러 매매기준율 없음", { status: 502 });
  const end = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  // 인증키가 URL 경로에 들어간다(ECOS 설계) — 오류 메시지에 URL 을 넣지 말 것
  const path = SERIES[kind].replace("{a}", "20150101").replace("{b}", end);
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${k}/json/kr/1/100000/${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), next: { revalidate: 60 * 60 * 12 } });
  if (!res.ok) throw new AdapterError(`ECOS 원/달러 환율(${kind}) HTTP ${res.status}`, { status: 502 });
  const j = (await res.json()) as { StatisticSearch?: { row?: { TIME: string; DATA_VALUE: string }[] } };
  const data = (j.StatisticSearch?.row ?? [])
    .map((r) => ({ date: `${r.TIME.slice(0, 4)}-${r.TIME.slice(4, 6)}-${r.TIME.slice(6, 8)}`, krwPerUsd: Number(r.DATA_VALUE) }))
    .filter((p) => Number.isFinite(p.krwPerUsd) && p.krwPerUsd > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (data.length < 100) throw new AdapterError("ECOS 원/달러 환율 응답 없음", { status: 502 });
  return data;
}

/** 원/달러 일별 시계열(2015~, 12시간 캐시) */
export async function fetchEcosKrwPerUsd(kind: EcosFxKind = "reference"): Promise<EcosFxPoint[]> {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const pending = inFlight.get(kind);
  if (pending) return pending;
  const p = load(kind)
    .then((data) => {
      cache.set(kind, { at: Date.now(), data });
      return data;
    })
    .finally(() => inFlight.delete(kind));
  inFlight.set(kind, p);
  return p;
}
