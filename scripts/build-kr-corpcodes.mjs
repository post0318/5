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

// ── 현재 상장 종목만 남긴다 ─────────────────────────────────────────
// DART corpCode.xml 은 stock_code 가 있는 법인을 "상장사"로 보이게 하지만
// 실제로는 상장폐지·합병 소멸 법인도 옛 코드를 그대로 달고 남아 있다(실측
// 2026-09-28: 삼성물산이 000830(2015년 소멸)과 028260(현행) 둘 다, 씨제이인터넷
// 037150·한빛네트 036720 등 상폐 종목 다수). 이 표로 이름→종목코드를 풀면
// 완전일치도 옛 법인에 붙어 리포트가 현행 종목 페이지에 안 뜬다. 그래서 KRX
// 전종목 시세(코스피+코스닥)에 오늘 기준으로 존재하는 코드만 남긴다.
// KONEX 는 이 키로 조회 권한이 없어(401) 제외 — 리서치 커버리지에 거의 없다.
const krxKey = process.env.KRX_API_KEY || (() => {
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return env.match(/^KRX_API_KEY="?([^"\n]+)"?/m)?.[1];
  } catch { return undefined; }
})();
if (!krxKey) {
  console.error("KRX_API_KEY 없음 — 상장 여부 필터를 못 걸어 중단");
  process.exit(1);
}
async function krxCodes(service, basDd) {
  const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/sto/${service}?basDd=${basDd}`, {
    headers: { AUTH_KEY: krxKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`KRX ${service} ${r.status}`);
  return ((await r.json()).OutBlock_1 ?? []).map((x) => x.ISU_CD);
}
const listed = new Set();
// 휴장일이면 응답이 비므로 최근 거래일을 찾을 때까지 하루씩 거슬러 간다
for (let back = 0; back < 10 && listed.size === 0; back++) {
  const d = new Date(Date.now() - back * 86_400_000);
  const basDd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const [a, b] = await Promise.all([krxCodes("stk_bydd_trd", basDd), krxCodes("ksq_bydd_trd", basDd)]);
  for (const c of [...a, ...b]) listed.add(c);
  if (listed.size) console.log(`KRX 상장종목 ${listed.size}개 (기준일 ${basDd})`);
}
if (listed.size < 2000) {
  console.error(`KRX 상장종목 수가 비정상(${listed.size}) — 표를 갱신하지 않고 중단`);
  process.exit(1);
}
const before = out.length;
const kept = out.filter((x) => listed.has(x.s));
console.log(`DART 코드 보유 법인 ${before}개 중 현재 상장 ${kept.length}개 (제외 ${before - kept.length})`);
out.length = 0;
out.push(...kept);

mkdirSync(new URL("../src/lib/markets/kr/data/", import.meta.url), { recursive: true });
const path = new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url);
writeFileSync(path, JSON.stringify(out));
console.log(`상장사 ${out.length}개 → src/lib/markets/kr/data/corpcodes.json (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
