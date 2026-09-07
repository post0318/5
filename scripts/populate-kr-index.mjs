/**
 * KOSPI·KOSDAQ 지수 일별 종가(과거분, 2015~2020)를 KRX 다운로드 xlsx 에서 파싱해
 * MongoDB(kr_index_daily)에 적재. 금융위 지수시세 API 는 2020~ 만 커버하므로 그 이전 보충용.
 *
 *   node scripts/populate-kr-index.mjs <KOSPI xlsx...> --kosdaq <KOSDAQ xlsx...>
 *
 * 예) node scripts/populate-kr-index.mjs \
 *       ~/Downloads/data_1750_20260908.xlsx ~/Downloads/data_1816_20260908.xlsx ~/Downloads/data_1846_20260908.xlsx \
 *       --kosdaq \
 *       ~/Downloads/data_1918_20260908.xlsx ~/Downloads/data_1934_20260908.xlsx ~/Downloads/data_1945_20260908.xlsx
 *
 * xlsx 구조: A=일자(YYYY/MM/DD), B=종가, E=시가, F=고가, G=저가 (역순 정렬). 1행 헤더.
 */
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { MongoClient } from "mongodb";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);
const URI = env.MONGODB_URI;
const DB = env.MONGODB_DB || "market_research";
if (!URI) throw new Error("MONGODB_URI 필요 (.env.local)");

function parseXlsx(path) {
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  const ssXml = files["xl/sharedStrings.xml"] ? strFromU8(files["xl/sharedStrings.xml"]) : "";
  const ss = (ssXml.match(/<si>[\s\S]*?<\/si>/g) ?? []).map((s) => s.replace(/<[^>]+>/g, ""));
  const sheetName =
    Object.keys(files).find((n) => /xl\/worksheets\/sheet1\.xml$/.test(n)) ??
    Object.keys(files).find((n) => /xl\/worksheets\/.*\.xml$/.test(n));
  const sheet = strFromU8(files[sheetName]);
  const out = [];
  for (const row of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells = {};
    const re = /<c r="([A-Z]+)\d+"([^>]*)>(?:<v>([^<]*)<\/v>)?<\/c>/g;
    let m;
    while ((m = re.exec(row))) {
      const [, col, attrs, v] = m;
      if (v == null) continue;
      cells[col] = attrs.includes('t="s"') ? ss[Number(v)] ?? v : v;
    }
    out.push(cells);
  }
  return out.slice(1); // 헤더 제거
}

function rows(paths, market) {
  const recs = [];
  for (const p of paths) {
    const parsed = parseXlsx(p);
    let n = 0;
    for (const c of parsed) {
      const d = String(c.A ?? "").replace(/\D/g, "");
      const close = Number(c.B);
      if (d.length !== 8 || !Number.isFinite(close) || close <= 0) continue;
      const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      recs.push({
        _id: `${market}:${d}`,
        market,
        date: iso,
        close,
        open: Number(c.E) || null,
        high: Number(c.F) || null,
        low: Number(c.G) || null,
      });
      n++;
    }
    console.log(`  ${p.split(/[\\/]/).pop()} [${market}] ${n}행`);
  }
  return recs;
}

const argv = process.argv.slice(2);
const kIdx = argv.indexOf("--kosdaq");
const kospiPaths = (kIdx === -1 ? argv : argv.slice(0, kIdx)).filter((a) => !a.startsWith("--"));
const kosdaqPaths = kIdx === -1 ? [] : argv.slice(kIdx + 1).filter((a) => !a.startsWith("--"));
if (kospiPaths.length === 0 && kosdaqPaths.length === 0)
  throw new Error("xlsx 경로 인자 필요");

console.log("파싱:");
const docs = [...rows(kospiPaths, "KOSPI"), ...rows(kosdaqPaths, "KOSDAQ")];
// _id 중복 제거 (파일 간 겹치는 날짜 대비)
const uniq = new Map(docs.map((d) => [d._id, d]));
const all = [...uniq.values()];

const cli = new MongoClient(URI);
await cli.connect();
const col = cli.db(DB).collection("kr_index_daily");
await col.createIndex({ market: 1, date: 1 }).catch(() => {});
if (all.length) {
  const res = await col.bulkWrite(
    all.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
  );
  console.log(`\n적재 ${all.length}건 (upsert ${res.upsertedCount}, 갱신 ${res.modifiedCount})`);
}
for (const mkt of ["KOSPI", "KOSDAQ"]) {
  const c = await col.countDocuments({ market: mkt });
  if (!c) continue;
  const lo = await col.find({ market: mkt }).sort({ date: 1 }).limit(1).next();
  const hi = await col.find({ market: mkt }).sort({ date: -1 }).limit(1).next();
  console.log(`  ${mkt}: ${c}건  ${lo.date} ~ ${hi.date}`);
}
await cli.close();
console.log("완료");
