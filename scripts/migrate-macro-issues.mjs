/**
 * 1회성 이관 스크립트 — `macro_issues` 컬렉션(문서가 적음)을 `kr_research`
 * (투자전략(채권) 콘텐츠가 훨씬 많음)로 흡수한다(오너 지시 2026-09-26,
 * "리서치 파이프라인 구조 전면 개편" — "실제이관을 넌 거꾸로하는데?").
 *
 * `src/lib/db/macro-issues.ts`·`/api/cron/macro-issues` 라우트는 이미 삭제됐으므로
 * 이 스크립트는 MongoDB 드라이버로 두 컬렉션에 직접 접근한다(그 파일들을 거치지
 * 않아야 이후 자유롭게 지울 수 있다 — 이미 지워짐).
 *
 * 변환 규칙:
 *  - `source`+`topic` 조합으로 고정 stockName을 부여한다(원본 MacroIssueDoc에는
 *    "KB Bond"/"자산배분매크로" 같은 세부 구분이 없고 topic만 있어 완벽 복원은
 *    불가 — source当 대표 라벨 하나로 뭉뚱그린다. 실측으로 확인된 source는
 *    "키움증권"·"KB증권" 둘뿐이었으나, 예상 밖 source가 나오면 안전망으로
 *    "이슈분석"/"환율분석" 그대로를 stockName으로 쓴다 — 둘 다
 *    shinhan-research.ts FORCED_ISSUE_STOCKNAMES/FORCED_FX_STOCKNAMES에 등록됨).
 *  - `category:"산업"`, `market:"kr"`, `symbol:null`, `opinion:""`,
 *    `targetPrice:null`, `views:null`.
 *  - `_id = "${source}:이관:${원본 _id}"` — 결정적이라 재실행해도 중복 없음
 *    (원본 macro_issues 문서는 지우지 않는다 — 이관 확인 후 별도 정리).
 *
 * 실행:
 *   node scripts/migrate-macro-issues.mjs --dry-run   # 건수만 확인, 쓰기 없음
 *   node scripts/migrate-macro-issues.mjs             # 실제 이관
 */

import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
      if (m && (env[m[1]] === undefined || env[m[1]] === "")) env[m[1]] = m[2];
    }
  } catch {
    /* .env.local 없어도 됨 */
  }
  return env;
}
const ENV = loadEnvLocal();
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");

const MONGODB_URI = (ENV.MONGODB_URI || "").trim();
const DB_NAME = (ENV.MONGODB_DB || "market_research").trim();
if (!MONGODB_URI) {
  console.error("✗ MONGODB_URI 가 없습니다(.env.local 또는 환경변수).");
  process.exit(1);
}

// source → { issue: 고정 이슈분석 라벨, fx: 고정 환율분석 라벨 }. 실측으로
// 확인된 macro_issues 소스는 키움증권(SI/FE)·KB증권(KB Bond/Fed Watch +
// 자산배분/매크로)뿐이다. KB는 세부 구분(Bond/Fed Watch vs 자산배분매크로)이
// 원본 문서에 안 남아있어 "KB 자산배분매크로"(더 넓은 대표 라벨)로 통일한다.
const SOURCE_LABELS = {
  키움증권: { issue: "키움 이슈분석", fx: "키움 환율분석" },
  KB증권: { issue: "KB 자산배분매크로", fx: "KB 자산배분매크로 FX" },
};
// 예상 밖 source 안전망 — shinhan-research.ts FORCED_ISSUE_STOCKNAMES/
// FORCED_FX_STOCKNAMES에 그대로 등록돼 있다.
const FALLBACK_LABELS = { issue: "이슈분석", fx: "환율분석" };

function labelFor(source, topic) {
  const pair = SOURCE_LABELS[source] ?? FALLBACK_LABELS;
  return topic === "환율분석" ? pair.fx : pair.issue;
}

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(DB_NAME);
const macroCol = db.collection("macro_issues");
const researchCol = db.collection("kr_research");

const macroDocs = await macroCol.find({}).toArray();
console.log(`▶ macro_issues 원본 ${macroDocs.length}건`);

if (macroDocs.length === 0) {
  console.log("✔ 이관할 문서가 없습니다.");
  await client.close();
  process.exit(0);
}

const bySourceTopic = new Map();
const converted = macroDocs.map((d) => {
  const label = labelFor(d.source, d.topic);
  const key = `${d.source}|${d.topic}|${label}`;
  bySourceTopic.set(key, (bySourceTopic.get(key) ?? 0) + 1);
  if (!SOURCE_LABELS[d.source]) {
    console.warn(`  ⚠ 예상 밖 source "${d.source}" — 안전망 라벨("${label}") 사용`);
  }
  return {
    _id: `${d.source}:이관:${d._id}`,
    source: d.source,
    market: "kr",
    date: d.date,
    title: d.title,
    stockName: label,
    symbol: null,
    analyst: d.analyst ?? "",
    opinion: "",
    targetPrice: null,
    summary: d.summary ?? "",
    pdfUrl: d.pdfUrl ?? null,
    views: null,
    collectedAt: d.collectedAt ?? new Date().toISOString(),
    category: "산업",
  };
});

console.log("  source×topic 분포:");
for (const [key, count] of [...bySourceTopic].sort()) {
  const [source, topic, label] = key.split("|");
  console.log(`    ${source} / ${topic} → "${label}": ${count}건`);
}

if (DRY_RUN) {
  console.log("\n--dry-run: kr_research 쓰기 생략");
  await client.close();
  process.exit(0);
}

const result = await researchCol.bulkWrite(
  converted.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
  { ordered: false },
);
const migratedIn = result.upsertedCount + result.modifiedCount;
console.log(`✔ kr_research 이관 완료: ${migratedIn}건 (신규 ${result.upsertedCount} · 갱신 ${result.modifiedCount})`);
console.log(`  원본 macro_issues 문서는 지우지 않았습니다 — 확인 후 별도로 정리하세요.`);

await client.close();
