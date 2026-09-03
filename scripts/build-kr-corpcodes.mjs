/**
 * OpenDART corpCode.xml (28MB) 에서 상장사만 추출해 압축 JSON 으로 저장.
 * Vercel 서버리스에서 28MB XML 파싱 시 메모리/시간 부담 → 사전 빌드.
 *
 * 실행: node scripts/build-kr-corpcodes.mjs   (DART_API_KEY 필요, .env.local 자동 로드)
 * 주기적으로 재실행해 커밋 (신규 상장/상장폐지 반영).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

// .env.local 에서 DART_API_KEY 읽기
let key = process.env.DART_API_KEY;
if (!key) {
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    key = env.match(/^DART_API_KEY="?([^"\n]+)"?/m)?.[1];
  } catch {}
}
if (!key) {
  console.error("DART_API_KEY 없음");
  process.exit(1);
}

const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`, {
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
  console.error("다운로드 실패", res.status);
  process.exit(1);
}
const buf = new Uint8Array(await res.arrayBuffer());
const files = unzipSync(buf);
const xml = strFromU8(files[Object.keys(files).find((n) => n.toLowerCase().endsWith(".xml"))]);

const RE =
  /<list>\s*<corp_code>([^<]*)<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>\s*<corp_eng_name>([^<]*)<\/corp_eng_name>\s*<stock_code>([^<]*)<\/stock_code>/g;

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

const out = [];
let m;
while ((m = RE.exec(xml))) {
  const stockCode = m[4].trim();
  if (!/^\d{6}$/.test(stockCode)) continue;
  out.push({
    c: m[1].trim(), // corp_code
    s: stockCode, // stock_code
    n: decode(m[2]), // corp_name
    e: decode(m[3]), // corp_eng_name
  });
}

mkdirSync(new URL("../src/lib/markets/kr/data/", import.meta.url), { recursive: true });
const path = new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url);
writeFileSync(path, JSON.stringify(out));
console.log(`상장사 ${out.length}개 → src/lib/markets/kr/data/corpcodes.json (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
