// 출처별 데이터 신선도 점검(2026-10-06, 전수조사 구멍 #5 — 수집기가 "성공"인데 저장이 며칠째 0 이어도 아무도 몰랐다:
// 신영 08-28, 국민은행·FRB·DB증권·흥국 09-17, BlackRock 09-21 …). 읽기 전용.
//
// 출처마다 최근 90일 실측 발행일로 "평소 간격"을 구하고, 마지막 글 이후 지난 영업일이 그 간격 × 여유를 넘으면 오래됨으로 판정한다.
//   - 대상: kr_research 의 source 별 + 고정 계열(kr_fg_daily 외국인 선물·KRX 원자료, fedwatch_daily, analyst_forecasts)
//   - 영업일: 그 출처 글의 절반 이상이 국내(market kr)면 KRX 휴장일 달력(앱 market-calendar.ts 와 같은 표), 아니면 주말만 뺀다
//   - 평소 간격 = 90일 안 연속 발행일 사이 영업일 수의 90백분위, 기준 = max(3, 올림(평소 간격 × 2)) 영업일
//   - 90일 안 발행일이 4일 미만이면 표본 부족 — 기준 10영업일(2주) 고정. 보존기간(시황 7일 등)·공통 제외로 DB 에 이력이 거의 안 남는
//     출처(BlackRock — 위클리는 주간물 제외, 투자전망은 날짜 근사로 바로 정리)도 이 기준으로 2주 넘게 새 글이 없으면 잡힌다.
//     원래 드문 출처가 오래됨으로 잡히면 1호기 /opt/macro/ops/freshness-ignore.txt 에 출처 이름을 한 줄씩 넣어 뺀다(오너 결정 시).
//   - 스냅샷 교체형(analyst_forecasts — 매 수집이 수집일을 덮어씀)은 발행일 이력이 없어 매일 작업 기준(평소 1영업일)으로 본다
// 1호기에서는 하루 1회(macro-research-freshness 타이머, ops/oracle/research-freshness.sh)가 --json 으로 돌려 결과 파일을 남기고,
// 10분마다 도는 healthcheck.sh 는 그 파일만 읽어 묶음 알림 한 건을 연다(10분마다 DB 를 읽지 않는다).
//
// 사용: node scripts/db/research-freshness.mjs [--json] [--today=YYYY-MM-DD] [--env=.env.local 경로]
//   MONGODB_URI(·MONGODB_DB) 는 환경변수 → 없으면 --env 파일 → 없으면 ./.env.local 에서 읽는다.
import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { isKrxHolidaySync, kstToday } from "../lib/collector-status.mjs";

const ARGS = process.argv.slice(2);
const arg = (k) => ARGS.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const JSON_OUT = ARGS.includes("--json");
const TODAY = arg("today") ?? kstToday();
const WINDOW_DAYS = 90;
const MIN_POINTS = 4;
const SPARSE_THRESHOLD = 10;
const SLACK = 2;
const FLOOR = 3;

function loadEnv() {
  if (process.env.MONGODB_URI) return;
  const path = arg("env") ?? ".env.local";
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(MONGODB_URI|MONGODB_DB)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // 파일 없음 — 아래에서 MONGODB_URI 없음으로 실패
  }
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const isOpen = (cal, d) => {
  if (cal === "kr") return isKrxHolidaySync(d) !== true; // 표에 없는 해(null)는 평일로 본다
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};
/** a 다음 날부터 b 까지(b 포함) 영업일 수 */
function openDaysBetween(cal, a, b) {
  let n = 0;
  for (let d = addDays(a, 1), i = 0; d <= b && i < 4000; d = addDays(d, 1), i++) if (isOpen(cal, d)) n++;
  return n;
}
function p90(xs) {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
}

/** 한 계열 판정 — dates: 90일 안 발행일(YYYY-MM-DD), last: 전체 기간 마지막 날, typicalOverride: 이력 없이 정한 평소 간격 */
function judge(name, cal, dates, last, typicalOverride = null) {
  const uniq = [...new Set(dates)].sort();
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) {
    const g = openDaysBetween(cal, uniq[i - 1], uniq[i]);
    if (g > 0) gaps.push(g);
  }
  const sparse = typicalOverride == null && (uniq.length < MIN_POINTS || gaps.length === 0);
  const typical = typicalOverride ?? (sparse ? null : p90(gaps));
  const threshold = sparse ? SPARSE_THRESHOLD : Math.max(FLOOR, Math.ceil(typical * SLACK));
  const age = last ? openDaysBetween(cal, last, TODAY) : null;
  return { source: name, cal, last, points: uniq.length, typicalBd: typical, thresholdBd: threshold, ageBd: age, sparse, stale: age == null || age > threshold };
}

loadEnv();
if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI 없음");
  process.exit(1);
}
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20_000 });
await client.connect();
const results = [];
try {
  const db = client.db(process.env.MONGODB_DB || "market_research");
  const since = addDays(TODAY, -WINDOW_DAYS);

  // kr_research — 출처별 90일 발행일 + 전체 마지막 날(가벼운 집계 두 번)
  const recent = await db.collection("kr_research").aggregate([
    { $match: { date: { $gte: since } } },
    { $group: { _id: "$source", dates: { $addToSet: { $substrCP: ["$date", 0, 10] } }, n: { $sum: 1 }, kr: { $sum: { $cond: [{ $in: [{ $ifNull: ["$market", "kr"] }, ["kr"]] }, 1, 0] } } } },
  ]).toArray();
  const lasts = new Map((await db.collection("kr_research").aggregate([{ $group: { _id: "$source", last: { $max: "$date" } } }]).toArray()).map((r) => [r._id, String(r.last ?? "").slice(0, 10)]));
  const recentBy = new Map(recent.map((r) => [r._id, r]));
  for (const [source, last] of lasts) {
    if (!source) continue;
    const r = recentBy.get(source);
    const cal = r && r.kr * 2 >= r.n ? "kr" : r ? "wd" : "kr";
    results.push({ kind: "research", ...judge(source, cal, r?.dates ?? [], last || null) });
  }

  // 고정 계열 — 같은 판정식(평소 간격은 실측)
  const fg = await db.collection("kr_fg_daily").find({ _id: { $gte: since } }, { projection: { foreignFutNet: 1, kospiClose: 1 } }).toArray();
  const fgLast = async (field) => (await db.collection("kr_fg_daily").find({ [field]: { $ne: null } }, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray())[0]?._id ?? null;
  results.push({ kind: "series", ...judge("외국인 선물 순매수(kr_fg_daily · macro-foreign-fut)", "kr", fg.filter((d) => d.foreignFutNet != null).map((d) => d._id), await fgLast("foreignFutNet")) });
  results.push({ kind: "series", ...judge("KRX 공포·탐욕 원자료(kr_fg_daily · macro-kr-fg)", "kr", fg.filter((d) => d.kospiClose != null).map((d) => d._id), await fgLast("kospiClose")) });
  const fw = await db.collection("fedwatch_daily").find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(120).toArray();
  results.push({ kind: "series", ...judge("Fed 금리 확률(fedwatch_daily)", "wd", fw.map((d) => d._id).filter((d) => d >= since), fw[0]?._id ?? null) });
  const af = await db.collection("analyst_forecasts").aggregate([{ $group: { _id: { $substrCP: ["$collectedAt", 0, 10] } } }]).toArray();
  const afDates = af.map((d) => d._id).filter(Boolean).sort();
  results.push({ kind: "series", ...judge("애널리스트 투자의견(analyst_forecasts · 수집일)", "wd", afDates.filter((d) => d >= since), afDates.at(-1) ?? null, 1) });
} finally {
  await client.close();
}

results.sort((a, b) => Number(b.stale) - Number(a.stale) || (a.last ?? "").localeCompare(b.last ?? ""));
const stale = results.filter((r) => r.stale);
if (JSON_OUT) {
  console.log(JSON.stringify({ today: TODAY, checked: results.length, stale: stale.length, results }));
} else {
  console.log(`신선도 점검 ${TODAY} — ${results.length}개 중 오래됨 ${stale.length}개`);
  for (const r of results) {
    console.log(
      `${r.stale ? "✗" : "·"} ${r.source.padEnd(34)} 마지막 ${r.last ?? "없음"}  경과 ${String(r.ageBd ?? "-").padStart(3)}영업일  기준 ${String(r.thresholdBd).padStart(3)}${r.sparse ? "(표본 부족)" : `(평소 ${r.typicalBd})`}  90일 발행 ${r.points}일  ${r.cal}`,
    );
  }
}
