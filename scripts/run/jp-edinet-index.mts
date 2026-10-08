/**
 * EDINET 날짜 목록·재무 보고서 색인 채우기(오너 결정 2026-10-08 — 원본은 디스크, DB 는 작은 색인만).
 *  1) 지난 --days 일(JST 오늘부터 과거로) documents.json 목록을 디스크(EDINET_CACHE_DIR/list)에 받고 jp_docs 에 재무 보고서를 색인한다.
 *     이미 확정 색인된 날(jp_docs_days.final)이면서 디스크 목록도 있으면 건너뛴다 — 몇 번을 다시 돌려도 같고, 끊겨도 이어서 한다.
 *     EDINET 보관 범위 밖(목록 상태 404)이 연속으로 나오면 거기서 멈추고 자료가 있는 가장 이른 날을 알려 준다.
 *  2) 표본 회사(--samples, 기본 9곳)의 최신 有価証券報告書·半期報告書와 그 앞 4년 有報의 XBRL(type=1)을 디스크(EDINET_CACHE_DIR/doc)에 받는다.
 * 요청은 한 줄로 약 1초 간격(edinet-store.ts EDINET_MIN_GAP_MS).
 *
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/jp-edinet-index.mts
 *         [--days=1900] [--samples=E02144,E01777] [--no-samples] [--samples-only]
 * 필요한 환경변수(.env.local 에서도 읽음): MONGODB_URI, EDINET_API_KEY, EDINET_CACHE_DIR
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const has = (k: string) => process.argv.includes(`--${k}`);

/** 표본 9곳 — 티커 → EDINET 코드 */
const SAMPLES: Record<string, string> = {
  "7203": "E02144",
  "6758": "E01777",
  "9984": "E02778",
  "285A": "E35948",
  "6981": "E01914",
  "7011": "E02126",
  "8002": "E02498",
  "4063": "E00776",
  "6178": "E31748",
};
const fmtMB = (b: number) => `${(b / 1024 ** 2).toFixed(2)}MB`;

async function main() {
  // 환경변수를 읽은 뒤에 불러온다(db/index.ts 가 불러올 때 MONGODB_URI 를 읽음)
  const { isDbConfigured, getDb } = await import("@/lib/db");
  const { indexEdinetDays, jpDocsDaysCol, listJpReports } = await import("@/lib/db/jp-docs");
  const { edinetCacheRoot, edinetCacheStats, edinetDocZip, hasDayListOnDisk, recentDates, redactEdinet } = await import("@/lib/markets/jp/edinet-store");
  const { isFetchFailure } = await import("@/lib/markets/http");
  if (!isDbConfigured()) throw new Error("MONGODB_URI 미설정");
  if (!process.env.EDINET_API_KEY) throw new Error("EDINET_API_KEY 미설정");
  if (!edinetCacheRoot()) throw new Error("EDINET_CACHE_DIR 미설정");
  const msg = (e: unknown) => redactEdinet(e instanceof Error ? e.message : String(e));
  const started = Date.now();
  let failedDays = 0;

  if (!has("samples-only")) {
    const days = Number(arg("days") ?? 1900);
    const dates = recentDates(days);
    const done = new Set(
      (await (await jpDocsDaysCol()).find({ _id: { $in: dates }, final: true }, { projection: { _id: 1 } }).toArray()).map((d) => d._id),
    );
    console.log(`대상 ${dates.length}일 (${dates[dates.length - 1]} ~ ${dates[0]}) · 확정 색인 ${done.size}일`);
    let skipped = 0, indexed = 0, docs = 0, reports = 0, oldest404: string | null = null, earliest: string | null = null, run404 = 0;
    const failed: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      if (done.has(d) && (await hasDayListOnDisk(d))) {
        skipped++;
        earliest = d;
        continue;
      }
      try {
        const [r] = await indexEdinetDays([d]);
        indexed++;
        docs += r.count;
        reports += r.reports;
        earliest = d;
        run404 = 0;
      } catch (e) {
        if (isFetchFailure(e) && e.opts.status === 404) {
          // 보관 범위 밖 — 연속 10일이면 더 과거도 없다고 본다
          oldest404 ??= d;
          if (++run404 >= 10) {
            console.log(`EDINET 목록 보관 범위 끝 — ${d} 부터 과거는 상태 404. 자료가 있는 가장 이른 날: ${earliest ?? "없음"}`);
            break;
          }
          continue;
        }
        failed.push(d);
        console.warn(`실패 ${d}: ${msg(e)}`);
      }
      if ((indexed + failed.length) % 50 === 0 && indexed) {
        const per = (Date.now() - t0) / (indexed + failed.length);
        const left = dates.length - i - 1;
        console.log(
          `진행 ${i + 1}/${dates.length} (${d}) · 색인 ${indexed}일 건너뜀 ${skipped} 실패 ${failed.length} · 목록 ${docs}건 중 재무 보고서 ${reports}건 · 요청 ${edinetCacheStats.requests} · 남은 예상 ≤${Math.round((left * per) / 60000)}분`,
        );
      }
    }
    // 실패한 날은 끝에서 한 번 더
    for (const d of [...failed]) {
      try {
        await indexEdinetDays([d]);
        failed.splice(failed.indexOf(d), 1);
        indexed++;
      } catch (e) {
        console.warn(`재시도 실패 ${d}: ${msg(e)}`);
      }
    }
    failedDays = failed.length;
    console.log(
      `목록 완료 ${Math.round((Date.now() - t0) / 1000)}초 · 색인 ${indexed}일 · 건너뜀 ${skipped}일 · 실패 ${failed.length}일${failed.length ? ` (${failed.join(",")})` : ""} · 가장 이른 자료일 ${earliest}${oldest404 ? ` · 404 시작 ${oldest404}` : ""}`,
    );
  }

  // ── 표본 회사 XBRL ──
  if (!has("no-samples")) {
    const codes = arg("samples") ? arg("samples")!.split(",").map((s) => s.trim()) : Object.values(SAMPLES);
    let got = 0, bytes = 0;
    const missing: string[] = [];
    for (const code of codes) {
      const asr = (await listJpReports(code, ["120"])).filter((r) => r.xbrlFlag === "1").slice(0, 5);
      const semi = (await listJpReports(code, ["160"])).filter((r) => r.xbrlFlag === "1").slice(0, 1);
      const picks = [...asr, ...semi];
      if (!asr.length) missing.push(`${code} 有報 없음`);
      for (const r of picks) {
        try {
          const z = await edinetDocZip(r._id, 1);
          got++;
          bytes += z.byteLength;
          console.log(`${code} ${r.docTypeCode} ${r._id} ${r.periodEnd ?? ""} ${(r.submitDateTime ?? "").slice(0, 10)} ${fmtMB(z.byteLength)}`);
        } catch (e) {
          missing.push(`${code} ${r._id}: ${msg(e)}`);
          console.warn(`표본 실패 ${code} ${r._id}: ${msg(e)}`);
        }
      }
    }
    console.log(`표본 XBRL ${got}건 ${fmtMB(bytes)}${missing.length ? ` · 빠짐: ${missing.join(" / ")}` : ""}`);
  }

  // ── DB 용량 ──
  const db = await getDb();
  for (const c of ["jp_docs", "jp_docs_days"]) {
    const s = (await db.command({ collStats: c })) as { count: number; size: number; avgObjSize?: number; storageSize: number; totalIndexSize: number };
    console.log(
      `DB ${c}: ${s.count}건 · 자료 ${fmtMB(s.size)} (평균 ${Math.round(s.avgObjSize ?? 0)}B) · 저장 ${fmtMB(s.storageSize)} · 색인 ${fmtMB(s.totalIndexSize)}`,
    );
  }
  const ds = (await db.command({ dbStats: 1 })) as { dataSize: number; storageSize: number; indexSize: number };
  console.log(`DB 전체: 자료 ${fmtMB(ds.dataSize)} · 저장 ${fmtMB(ds.storageSize)} · 색인 ${fmtMB(ds.indexSize)}`);
  console.log(`EDINET 요청 ${edinetCacheStats.requests}건 · 받은 양 ${fmtMB(edinetCacheStats.bytes)} · 디스크 적중 ${edinetCacheStats.hit} · 저장 ${edinetCacheStats.write} · ${Math.round((Date.now() - started) / 1000)}초`);
  return failedDays ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("::error::", e instanceof Error ? e.message.replace(/Subscription-Key=[^&\s"']*/gi, "Subscription-Key=***") : e);
    process.exit(1);
  });
