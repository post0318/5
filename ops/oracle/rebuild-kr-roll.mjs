// 한국 공포·탐욕 52주 신고·신저 판정용 종목별 종가 창(kr_stock_roll)을 KRX 원자료로 다시 만든다(1회성 복구 도구, 2026-10-03).
//
// 왜: 창에 같은 날 종가가 2~3번씩 중복으로 들어가 있었다(2026-09 에 고친 중복 push 버그의 흔적 — 예: 005930 의 09-04 종가가
// 3번). 거기에 과거 날짜를 다시 받는 백필이 겹쳐 순서도 꼬였다. 창은 "날짜를 앞으로만 덧붙이는" 구조라 부분 수리가 안 된다.
//
// 하는 일:
//   1. kr_fg_daily 의 거래일(휴장 제외) 중 마지막 N(기본 275)일을 날짜순으로 정한다.
//   2. 날짜마다 KRX 유가증권 전종목 일별매매(sto/stk_bydd_trd)를 받아 종목별 종가를 날짜순으로 쌓는다.
//   3. 마지막 RECOMPUTE(기본 22)일의 52주 신고·신저·판정 대상 수를 배치와 같은 규칙으로 다시 계산해 kr_fg_daily 에 쓴다
//      (창 = 그날 이전 최대 252거래일, 200일 이상일 때만 판정, 종가 >= 창 최고 → 신고, <= 창 최저 → 신저).
//   4. 마지막 날 종가가 있는 종목의 창을 마지막 252일로 바꾸고 lastDate 를 맞춘다. 바꾸기 전 창은 백업 파일로 남긴다.
//
// 실행(오라클 서버, 앱 이미지의 node_modules 사용):
//   docker run --rm --network host --env-file /opt/macro/app.env -v /opt/macro/ops:/ops \
//     macro:<커밋> node /ops/rebuild-kr-roll.mjs [--days=275] [--recompute=22] [--dry-run]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
// 앱 이미지(standalone)의 node_modules 는 배포용으로 다듬어져 패키지 진입점 해석이 안 된다 — 파일 경로로 직접 불러온다.
const { MongoClient } = createRequire(import.meta.url)("/app/node_modules/mongodb/lib/index.js");

const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1]) || d;
const DAYS = arg("days", 275);
const RECOMPUTE = arg("recompute", 22);
const DRY = process.argv.includes("--dry-run");
const WINDOW = 252;
const MIN_HISTORY = 200;
const KEY = process.env.KRX_API_KEY;
if (!KEY || !process.env.MONGODB_URI) throw new Error("KRX_API_KEY·MONGODB_URI 필요");

const client = await MongoClient.connect(process.env.MONGODB_URI);
const db = client.db("market_research");
const daily = db.collection("kr_fg_daily");
const rollCol = db.collection("kr_stock_roll");

const dates = (await daily.find({ closed: { $ne: true }, advancers: { $ne: null } }, { projection: { _id: 1 } })
  .sort({ _id: -1 }).limit(DAYS).toArray()).map((d) => d._id).reverse();
console.log(`거래일 ${dates.length}일: ${dates[0]} ~ ${dates.at(-1)}`);

const series = new Map(); // code → [{date, close}]
for (const [i, date] of dates.entries()) {
  const basDd = date.replace(/-/g, "");
  let rows = null;
  for (let t = 0; t < 3 && !rows; t++) {
    try {
      const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd?basDd=${basDd}`, {
        headers: { AUTH_KEY: KEY }, signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) rows = (await r.json()).OutBlock_1 ?? [];
    } catch { /* 재시도 */ }
    if (!rows) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!rows || rows.length < 100) throw new Error(`${date} KRX 응답 이상(${rows?.length ?? "실패"}) — 중단`);
  for (const r of rows) {
    const close = Number(r.TDD_CLSPRC);
    if (!r.ISU_CD || !Number.isFinite(close) || close <= 0) continue;
    if (!series.has(r.ISU_CD)) series.set(r.ISU_CD, []);
    series.get(r.ISU_CD).push({ date, close });
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${dates.length} (${date})`);
  await new Promise((r) => setTimeout(r, 250));
}

// 3. 마지막 RECOMPUTE 일 재계산
const targets = dates.slice(-RECOMPUTE);
const results = [];
for (const date of targets) {
  let hi = 0, lo = 0, total = 0;
  for (const arr of series.values()) {
    const idx = arr.findIndex((p) => p.date === date);
    if (idx < 0) continue;
    const prev = arr.slice(Math.max(0, idx - WINDOW), idx).map((p) => p.close);
    if (prev.length < MIN_HISTORY) continue;
    total++;
    const c = arr[idx].close;
    if (c >= Math.max(...prev)) hi++;
    else if (c <= Math.min(...prev)) lo++;
  }
  const before = await daily.findOne({ _id: date }, { projection: { newHigh52: 1, newLow52: 1, totalWithHistory: 1 } });
  results.push({ date, before: `${before?.newHigh52}/${before?.newLow52}/${before?.totalWithHistory}`, after: `${hi}/${lo}/${total}` });
  if (!DRY) await daily.updateOne({ _id: date }, { $set: { newHigh52: hi, newLow52: lo, totalWithHistory: total || null } });
}
console.table(results);

// 4. 창 교체(마지막 날 종가가 있는 종목)
const last = dates.at(-1);
const backup = await rollCol.find({}).toArray();
writeFileSync(`/ops/roll-before-rebuild-${last}.json`, JSON.stringify(backup));
const ops = [];
for (const [code, arr] of series) {
  if (arr.at(-1)?.date !== last) continue;
  ops.push({ updateOne: { filter: { _id: code }, update: { $set: { closes: arr.slice(-WINDOW).map((p) => p.close), lastDate: last } }, upsert: true } });
}
if (!DRY && ops.length) await rollCol.bulkWrite(ops, { ordered: false });
console.log(`창 교체 ${ops.length}종목${DRY ? "(dry-run, 쓰지 않음)" : ""} · 백업 /ops/roll-before-rebuild-${last}.json (${backup.length}건)`);
await client.close();
