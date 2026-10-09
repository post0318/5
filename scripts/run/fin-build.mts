/**
 * 재무 5층 구조 배치 갱신 — GitHub Actions 실행 서버에서 직접 조립해 DB 에 저장한다(운영 서버 CPU 사용 안 함, 2026-10-03 오너 결정).
 * 예전엔 워크플로가 운영 앱 /api/cron/fin-build 를 불러 Vercel 이 조립했다(종목당 30~40초) — Hobby Active CPU 한도(월 4시간) 초과의 한 원인.
 * 판정·조립은 라우트와 같은 함수(refreshStored)라 결과가 같다(AAPL·TSM·XOM 저장본과 칸별 일치 실측).
 *
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/fin-build.mts [--symbols=AAPL,KO] [--minutes=90] [--dry]
 *   --dry : 갱신 대상만 판정하고 조립·저장하지 않는다(로컬 확인용)
 * 필요한 환경변수: MONGODB_URI(필수), SEC_USER_AGENT(권장)
 */
import { refreshStored } from "@/lib/fin";
import { isDbConfigured } from "@/lib/db";
import { listRecentlyViewed } from "@/lib/db/ttm-snap";
import { listUniverseDistinct } from "@/lib/universe/repo";

const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/;
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

async function main() {
  if (!isDbConfigured()) throw new Error("MONGODB_URI 미설정");
  const minutes = Number(arg("minutes") ?? 90);
  const dry = process.argv.includes("--dry");
  const symbols = arg("symbols")
    ? arg("symbols")!.split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s))
    : // 유니버스 + 최근 30일 안에 화면에서 조회된 종목(라우트와 같은 대상)
      [...new Set([...(await listUniverseDistinct({ market: "us" })).map((u) => u.symbol.toUpperCase()), ...(await listRecentlyViewed("us"))])];
  console.log(`대상 ${symbols.length}종목${dry ? " (판정만)" : ""}`);
  if (dry) {
    // 판정만: max 0 이면 조립 없이 끝나므로 저장본 메타만 확인하는 용도로 쓰지 않는다 — 대상 목록만 출력
    console.log(symbols.join(","));
    return 0;
  }
  const started = Date.now();
  const r = await refreshStored("us", symbols, { max: 10_000, deadline: started + minutes * 60_000 });
  // 변경 = 손익계산서·핵심 지표 저장본(fin_stmt·fin_sym)의 바뀐 칸(fin_chg). 현금흐름표·재무상태표 칸 변경은 ttm-build 가 기록(view-snap.ts)
  for (const b of r.built) console.log(`조립 ${b.symbol} (${b.why})${b.error ? ` 오류: ${b.error}` : ` 손익·지표 바뀐 칸 ${b.changed ?? 0}${b.gaps.length ? ` 결손 ${b.gaps.join("·")}` : ""}${b.cols?.length ? ` · 열 표시 ${b.cols.join("·")}` : ""}`}`);
  const errs = r.built.filter((b) => b.error);
  console.log(`완료 ${Math.round((Date.now() - started) / 1000)}초 · 조립 ${r.built.length} (오류 ${errs.length}) · 최신 ${r.upToDate.length} · 건너뜀 ${r.skipped.length} · 남음 ${r.pending}`);
  if (r.skipped.length) console.log(`::warning::제출 목록 조회 실패로 건너뛴 종목: ${r.skipped.join(",")}`);
  if (r.pending) console.log(`::warning::시간 한도(${minutes}분)로 남은 종목 ${r.pending} — 다음 실행에서 이어서`);
  return errs.length || r.skipped.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("::error::", e);
    process.exit(1);
  });
