import "server-only";
import { fetchJson } from "../http";
import { AdapterError } from "../types";

/**
 * J-Quants API v2 (일본) — `x-api-key` 헤더 인증.
 * https://jpx-jquants.com/en/spec/
 *
 * 무료 플랜에서 가능:
 * - `/v2/equities/master`      : 상장 종목 마스터 (업종·규모구분·시장구분)
 * - `/v2/equities/bars/daily`  : 일별 시세 (단, 약 12주 지연 · 2년 윈도우)
 * 무료 플랜 불가:
 * - `/v2/fins/details`         : 재무제표 (유료 플랜) → JP 재무는 EDINET 사용
 */

const BASE = "https://api.jquants.com/v2";

function apiKey(): string | null {
  return process.env.JQUANTS_API_KEY ?? null;
}

export function hasJQuants(): boolean {
  return Boolean(apiKey());
}

function headers(): Record<string, string> {
  return { "x-api-key": apiKey()! };
}

export interface JQMaster {
  code: string;
  name: string;
  nameEn: string;
  sector17: string;
  sector33: string;
  scaleCategory: string;
  marketName: string;
}

const masterCache = new Map<string, { at: number; data: JQMaster | null }>();
const MASTER_TTL = 1000 * 60 * 60 * 24;

/** 상장 종목 마스터 (업종·규모·시장구분). 무료 플랜 가능. */
export async function fetchJQuantsMaster(code: string): Promise<JQMaster | null> {
  if (!apiKey()) return null;
  const local = code.replace(/[^0-9]/g, "");
  const hit = masterCache.get(local);
  if (hit && Date.now() - hit.at < MASTER_TTL) return hit.data;

  try {
    const j = await fetchJson<{ data?: Record<string, string>[] }>(
      `${BASE}/equities/master?code=${local}`,
      { headers: headers(), revalidate: 60 * 60 * 24 },
    );
    const row = j.data?.[0];
    const master: JQMaster | null = row
      ? {
          code: row.Code,
          name: row.CoName,
          nameEn: row.CoNameEn,
          sector17: row.S17Nm,
          sector33: row.S33Nm,
          scaleCategory: row.ScaleCat,
          marketName: row.MktNm,
        }
      : null;
    masterCache.set(local, { at: Date.now(), data: master });
    return master;
  } catch {
    return null;
  }
}

export interface JQBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/**
 * 일별 시세 (무료 플랜: 약 12주 지연, 2년 윈도우).
 * "현재가"로는 부적합 — 히스토리 차트/검증용.
 */
export async function fetchJQuantsBars(
  code: string,
  from: string,
  to: string,
): Promise<JQBar[]> {
  if (!apiKey()) throw new AdapterError("J-Quants API 키가 없습니다", { status: 501 });
  const local = code.replace(/[^0-9]/g, "");
  const j = await fetchJson<{ data?: Record<string, number | string>[] }>(
    `${BASE}/equities/bars/daily?code=${local}&from=${from.replace(/-/g, "")}&to=${to.replace(/-/g, "")}`,
    { headers: headers(), revalidate: 60 * 60 * 6 },
  );
  return (j.data ?? []).map((r) => ({
    date: String(r.Date),
    open: toNum(r.O),
    high: toNum(r.H),
    low: toNum(r.L),
    close: toNum(r.C),
    volume: toNum(r.Vo),
  }));
}

function toNum(v: number | string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
