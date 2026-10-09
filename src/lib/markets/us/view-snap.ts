import "server-only";
import type { Collection } from "mongodb";
import { getDb, isDbConfigured } from "@/lib/db";
import { finChgCol, type FinChgDoc } from "@/lib/db/fin";
import { snapshotBypassed } from "@/lib/db/snap-bypass";
import { ENGINE_VERSION } from "@/lib/fin";
import type { FinancialStatement } from "../types";
import { fetchUsCompanyFacts, fetchUsSic } from "./edgar";
import { buildUsBalance } from "./edgar-balance";
import { buildUsCashFlow } from "./edgar-cashflow";

/**
 * 재무제표 화면 칸 변경 기록(오너 승인 2026-10-09 — 저장본 교체 때 바뀐 칸 목록). 손익계산서·핵심 지표는 재무 저장본(fin_stmt·fin_sym)이라
 * fin/store.ts persist 가 fin_chg 에 남기지만, 현금흐름표·재무상태표는 요청 시점에 만들어 저장본이 없어 엔진판이 바뀌어도 기록이 없었다
 * (10-09 NVDA 투자자산 취득 LTM 공란 → −106,946 이 fin_chg 에 없음). TTM 채우기 배치(ttm-build)가 종목마다 화면과 같은 함수로 두 표(연간·분기)를
 * 만들어 직전 값(fin_view — 종목당 1건, 덮어씀)과 비교하고, 같은 열 라벨·같은 줄에서 값이 바뀐 칸만 fin_chg(t = "cf.a:줄 id" 등, 180일 TTL)에
 * 남긴다. 새로 생기거나 빠진 열(새 분기)은 칸 변경이 아니라 건수로만 돌려준다. 원본 조회 경고가 있는 계산은 기준값을 덮지 않는다.
 */
interface ViewTable { c: string[]; r: [string, (number | null)[]][] }
interface FinViewDoc { _id: string; ev: number; at: Date; s: Record<string, ViewTable> }

const KINDS: [string, (f: Parameters<typeof buildUsCashFlow>[0], sic: string | null) => FinancialStatement][] = [
  ["cf.a", (f, s) => buildUsCashFlow(f, "annual", s)],
  ["cf.q", (f, s) => buildUsCashFlow(f, "quarter", s)],
  ["bs.a", (f, s) => buildUsBalance(f, "annual", s)],
  ["bs.q", (f, s) => buildUsBalance(f, "quarter", s)],
];

async function col(): Promise<Collection<FinViewDoc>> {
  return (await getDb()).collection<FinViewDoc>("fin_view");
}

function table(st: FinancialStatement): ViewTable {
  const c = st.periods.map((p) => p.label);
  const r: ViewTable["r"] = [];
  for (const it of st.sections.flatMap((s) => s.items)) if (it.accountId) r.push([it.accountId, c.map((l) => it.values?.[l] ?? null)]);
  return { c, r };
}

export interface ViewChange { changed: number; newCols: number; baseline: boolean }

/**
 * 종목 재무제표 화면(현금흐름표·재무상태표) 칸 비교·기록. 기록할 수 없으면 null — DB 없음·검증 우회·비저장 모드, 그리고 기준값이 될 수 없는
 * 계산(하이라이트 저장본 degraded 와 같은 조건: 원본 조회 경고·판독 불가 sourceUnavailable · 외화 환산 대기 fxPending · SIC 조회 실패 ·
 * 재무 저장본 옛 엔진판 staleEv)
 */
export async function recordUsViewChanges(symbol: string): Promise<ViewChange | null> {
  // 비저장 모드(FIN_NO_PERSIST — fin/store.ts 와 같은 차단)·검증 우회 요청은 기록하지 않는다
  if (!isDbConfigured() || process.env.FIN_NO_PERSIST || (await snapshotBypassed())) return null;
  const sym = symbol.toUpperCase();
  let sicFailed = false;
  const [{ facts }, sic] = await Promise.all([fetchUsCompanyFacts(sym), fetchUsSic(sym).catch(() => { sicFailed = true; return null; })]);
  if (facts.fetchWarnings?.length || facts.sourceUnavailable || facts.fxPending || sicFailed || facts.revenue?.staleEv != null) return null;
  const s: Record<string, ViewTable> = {};
  for (const [k, build] of KINDS) s[k] = table(build(facts, sic));
  const id = `us:${sym}`;
  const now = new Date();
  const prev = await (await col()).findOneAndUpdate({ _id: id }, { $set: { ev: ENGINE_VERSION, at: now, s } }, { upsert: true, returnDocument: "before" });
  if (!prev) return { changed: 0, newCols: 0, baseline: true };
  const r: FinChgDoc["r"] = prev.ev !== ENGINE_VERSION ? "ev" : "data";
  const chg: FinChgDoc[] = [];
  let newCols = 0;
  for (const [k, cur] of Object.entries(s)) {
    const old = prev.s?.[k];
    if (!old) continue;
    const oc = new Map(old.c.map((l, i) => [l, i]));
    newCols += cur.c.filter((l) => !oc.has(l)).length;
    const orow = new Map(old.r);
    for (const [line, vs] of cur.r) {
      const ov = orow.get(line);
      if (!ov) continue;
      cur.c.forEach((l, i) => {
        const j = oc.get(l);
        if (j == null) return;
        const o = ov[j] ?? null, n = vs[i] ?? null;
        if (o !== n) chg.push({ k: id, at: now, ev: ENGINE_VERSION, t: `${k}:${line}`, c: l, o, n, r });
      });
    }
  }
  // 변경 기록 실패는 기준값 교체에 영향 없음(감사 추적용) — 실패는 로그로 남긴다
  if (chg.length)
    await finChgCol()
      .then((c) => c.insertMany(chg))
      .catch((e) => console.error(`[fin_chg] ${id} 재무제표 칸 변경 기록 실패: ${e instanceof Error ? e.message : String(e)}`));
  return { changed: chg.length, newCols, baseline: false };
}
