/**
 * 새 유니버스 종목 미리 계산 처리기(오너 승인 2026-10-06) — 1호기 타이머 `fin-precompute`(5분마다)가 ops/oracle/run-precompute.sh 를 거쳐
 * run-ts.sh 로 실행한다. 대기열(precompute_queue — 유니버스에 전 계정 처음 담긴 종목만, src/lib/db/precompute-queue.ts)을 읽어:
 *   - 미국: 재무 조립(refreshStored — fin-build 와 같은 함수) → TTM 스냅샷(getTtm·isStorableTtm·writeTtmSnap — ttm-build 와 같은 함수)을
 *     그 종목만, 순서대로(SEC 동시 조회 금지). 회차당 US_PER_RUN 종목.
 *   - 한국: 감가상각 적재(kr_da)는 컨테이너 밖 실행기(run-kr-da.sh)가 하므로 이 스크립트는 종목을 꺼내(--kr) "KR_CLAIMED: 코드,…" 로 알려 주고,
 *     실행기 결과를 --kr-finish 로 받아 상태를 바꾼다. 회차당 KR_PER_RUN·24시간 KR_PER_DAY 종목(DART 운영 키 몫 — 05:50 fin-kr-da·운영 화면 몫을 남긴다).
 *     fin-kr-da 가 아직 없으면(--kr 없이 실행) 꺼내지 않고 "병합 후" 로그만 — 대기열에 남아 설치 뒤 처리된다(7일 TTL 안).
 * 실패는 재시도 2회(다음 회차) 뒤 failed — 지난 24시간 안에 failed 가 있으면 종료코드 1(healthcheck 의 job-fin-precompute 알림이 그동안 열려 있다).
 *
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/precompute.mts [--kr] [--dry]
 *       … scripts/run/precompute.mts --kr-finish=ok|fail|defer --codes=005930,000660 [--error=메시지]
 *   --dry : 대기열 건수만 출력(꺼내지도 계산하지도 않음)
 * 필요한 환경변수: MONGODB_URI(필수), SEC_USER_AGENT(권장), APP_COMMIT_SHA(TTM 저장 판번호 — run-ts.sh 가 넣는다)
 */
import { isDbConfigured } from "@/lib/db";
import {
  claimPrecompute,
  countClaimedSince,
  countPending,
  deferPrecompute,
  listRecentFailed,
  markPrecomputeDone,
  markPrecomputeFailed,
  type PrecomputeQueueDoc,
} from "@/lib/db/precompute-queue";
import { isStorableTtm, ttmSnapVersion, writeTtmSnap } from "@/lib/db/ttm-snap";
import { refreshStored } from "@/lib/fin";
import { getAdapter } from "@/lib/markets/registry";
import type { TtmFlows } from "@/lib/markets/types";

const US_PER_RUN = 10; // 회차당 미국 종목 상한(종목당 재무 30~40초 + TTM — 한 회차 10분 안팎, 그동안 다음 타이머 회차는 건너뛴다)
const KR_PER_RUN = 5; // 회차당 한국 종목 상한
const KR_PER_DAY = 30; // 24시간 한국 종목 상한(새 종목 전체 적재 ≈ DART 수십 건 — 적재 하루 상한 2,000건 중 1,000건 미만)
const PER_SYMBOL_MS = 180_000;
const DART_DEFER_MS = 6 * 3600_000; // DART 하루 상한에 걸리면 6시간 뒤로
const LIMIT_DEFER_MS = 3600_000; // 사용량 장부 상한(usage-ledger — 1호기 운영 키 일일 상한)에 닿으면 1시간 뒤 다시
// 사용량 장부 상한 오류(전역 fetch 가 name="UsageLimitError", http.ts 경유는 429) — 재무 조립은 오류를 문자열로만 돌려주므로 이름·문구 둘 다 본다
const USAGE_LIMIT_RE = /UsageLimit|\b429\b/;
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

async function processUs(docs: PrecomputeQueueDoc[]): Promise<void> {
  const adapter = getAdapter("us");
  let limited = false;
  for (const d of docs) {
    const sym = d.symbol.toUpperCase();
    // 사용량 장부 상한(UsageLimitError)에 닿았으면 남은 종목은 시도 횟수 없이 미룬다 — 회차를 끝내고 대기열은 그대로
    if (limited) { await deferPrecompute(d._id, LIMIT_DEFER_MS, "사용량 상한 — 이번 회차 중단"); continue; }
    const t0 = Date.now();
    try {
      const r = await refreshStored("us", [sym], { max: 1, deadline: Date.now() + PER_SYMBOL_MS, minBuildMs: 0 });
      const b = r.built.find((x) => x.symbol === sym);
      if (b?.error) throw new Error(`재무 조립: ${b.error}`);
      if (r.skipped.includes(sym)) throw new Error("재무: 제출 목록 조회 실패");
      if (!b && !r.upToDate.includes(sym)) throw new Error("재무: 조립되지 않음");
      if (!adapter.getTtm) throw new Error("미국 어댑터에 getTtm 없음");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<TtmFlows>((resolve) => {
        timer = setTimeout(() => resolve({ periodLabel: "", error: `시간 초과(${PER_SYMBOL_MS / 1000}초)`, netIncome: null, revenue: null, opIncome: null, eps: null }), PER_SYMBOL_MS);
      });
      const ttm = await Promise.race([adapter.getTtm(sym).catch((e) => ({ periodLabel: "", error: String(e) }) as TtmFlows), timeout]);
      clearTimeout(timer);
      if (!ttm || !isStorableTtm(ttm)) throw new Error(`TTM: ${ttm?.error ?? ttm?.degraded?.join("; ") ?? "TTM 없음"}`);
      await writeTtmSnap("us", sym, ttm);
      await markPrecomputeDone(d._id);
      console.log(`완료 us:${sym} ${Math.round((Date.now() - t0) / 1000)}초 (재무 ${b ? `조립 ${b.why}` : "최신"} · TTM 저장)`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (USAGE_LIMIT_RE.test(`${(e as Error)?.name ?? ""} ${msg}`)) {
        limited = true;
        await deferPrecompute(d._id, LIMIT_DEFER_MS, msg);
        console.log(`미룸 us:${sym} — 사용량 상한(${msg.slice(0, 120)}), 이번 회차 중단`);
        continue;
      }
      const st = await markPrecomputeFailed(d._id, msg);
      console.log(`실패 us:${sym} ${Math.round((Date.now() - t0) / 1000)}초 — ${msg.slice(0, 160)} → ${st === "failed" ? "최종 실패" : "다음 회차 재시도"}`);
    }
  }
}

async function finishKr(mode: string, codes: string[], error: string): Promise<void> {
  for (const c of codes) {
    const id = `kr:${c}`;
    if (mode === "ok") {
      await markPrecomputeDone(id);
      console.log(`완료 ${id} (감가상각 적재)`);
    } else if (mode === "defer") {
      await deferPrecompute(id, DART_DEFER_MS, error || "DART 하루 상한");
      console.log(`미룸 ${id} — ${error || "DART 하루 상한"} (6시간 뒤)`);
    } else {
      const st = await markPrecomputeFailed(id, error || "감가상각 적재 실패");
      console.log(`실패 ${id} — ${error || "감가상각 적재 실패"} → ${st === "failed" ? "최종 실패" : "다음 회차 재시도"}`);
    }
  }
}

async function main(): Promise<number> {
  if (!isDbConfigured()) throw new Error("MONGODB_URI 미설정");
  const finish = arg("kr-finish");
  if (finish) {
    const codes = (arg("codes") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9A-Z]{6}$/.test(s));
    await finishKr(finish, codes, arg("error") ?? "");
    return (await reportFailed()) ? 1 : 0;
  }
  const dry = process.argv.includes("--dry");
  const [usN, krN] = await Promise.all([countPending("us"), countPending("kr")]);
  console.log(`대기 us ${usN} · kr ${krN}${dry ? " (건수만)" : ""}`);
  if (dry) return 0;

  if (usN) {
    if (ttmSnapVersion() === "local") throw new Error("APP_COMMIT_SHA 미설정 — 로컬 판번호로 TTM 을 저장하면 운영이 읽지 않는다");
    await processUs(await claimPrecompute("us", US_PER_RUN));
  }

  if (krN) {
    if (!process.argv.includes("--kr")) {
      console.log(`한국 ${krN}종목 대기 — 감가상각 적재 실행기(fin-kr-da)가 아직 없음: 한국 검증 master 병합·배포 후 처리`);
    } else {
      const used = await countClaimedSince("kr", new Date(Date.now() - 24 * 3600_000));
      const room = Math.min(KR_PER_RUN, Math.max(0, KR_PER_DAY - used));
      const docs = await claimPrecompute("kr", room);
      if (docs.length) console.log(`KR_CLAIMED: ${docs.map((d) => d.symbol).join(",")}`);
      else if (!room) console.log(`한국 ${krN}종목 대기 — 24시간 상한(${KR_PER_DAY}종목) 도달, 다음 회차에`);
      else console.log(`한국 ${krN}종목 대기 — 모두 미룬 상태(DART 하루 상한, notBefore 이후 처리)`);
    }
  }

  return (await reportFailed()) ? 1 : 0;
}

/** 지난 24시간 안 최종 실패(재시도 2회 뒤)가 있으면 출력하고 true */
async function reportFailed(): Promise<boolean> {
  const failed = await listRecentFailed(new Date(Date.now() - 24 * 3600_000));
  if (failed.length) console.log(`::error::지난 24시간 최종 실패 ${failed.length}종목: ${failed.map((f) => `${f._id}(${(f.lastError ?? "").slice(0, 60)})`).join(", ")}`);
  return failed.length > 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("::error::", e);
    process.exit(1);
  });
