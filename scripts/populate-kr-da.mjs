/**
 * 한국 종목 감가상각비·무형자산상각비(연결)를 DART 사업보고서 XBRL 에서 파싱해
 * MongoDB(kr_da)에 연도별로 적재. 하나의 사업보고서 XBRL 은 당기+전기 2개년을 담으므로
 * 2년 간격으로 3건 조회해 ~6개년을 모은다.
 *
 * OpenDART XBRL 엔드포인트는 클라우드 IP(Vercel)를 차단하므로 로컬/개인 IP 에서 실행.
 * 분기·반기·사업보고서가 나올 때마다 재실행 권장 (야간배치 nightly.mjs 에 포함됨).
 *   node scripts/populate-kr-da.mjs [005930 000660 ...]
 * 인자 없으면 universe_items 의 한국 종목 전체.
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
const DART = env.DART_API_KEY;
const URI = env.MONGODB_URI;
const DB = env.MONGODB_DB || "market_research";
if (!DART || !URI) throw new Error("DART_API_KEY / MONGODB_URI 필요 (.env.local)");

const B = "https://opendart.fss.or.kr/api";
const CHECK = process.argv.includes("--check");
const corpMap = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const corpOf = (code) => {
  const d = code.replace(/\D/g, "").padStart(6, "0");
  const row = corpMap.find((r) => (r.s ?? r.stock_code) === d);
  return row ? (row.c ?? row.corp_code) : null;
};
const jget = (url) => fetch(url).then((r) => r.json());

/**
 * 특정 사업연도 사업보고서 접수번호들(최신 = 정정본 먼저). 보고서명의 대상 연도("(2023.12)")가 맞는 것만 — 이듬해 접수 목록에 지난 연도
 * 정정본도 섞인다(현대차 2024-03-14 "[기재정정]사업보고서 (2022.12)"를 2023 보고서로 잡았다, 2026-10-02). 정정본은 정정한 부분만 담아
 * 감사보고서가 없을 수 있어(SK 2021 기재정정) 순서대로 시도한다
 */
async function annualRcps(corp, year) {
  await new Promise((r) => setTimeout(r, 400));
  const j = await jget(
    `${B}/list.json?crtfc_key=${DART}&corp_code=${corp}` +
      `&bgn_de=${year + 1}0101&end_de=${year + 1}1231&pblntf_detail_ty=A001&page_count=100`,
  );
  const rows = (j.list ?? []).filter((r) => /사업보고서/.test(r.report_nm) && r.report_nm.includes(`(${year}.`));
  rows.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no));
  return rows.map((r) => r.rcept_no);
}

async function loadXbrl(rcpNo) {
  // DART 는 몰아서 요청하면 이 PC 연결을 약 1시간 막는다(실측 2026-10-01) — XBRL 요청마다 1초 간격
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcpNo}&reprt_code=11011`);
  if (!res.ok) throw new Error(`xbrl ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
  if (!name) throw new Error("xbrl not in zip");
  return strFromU8(files[name]);
}

const DEP_C = ["AdjustmentsForDepreciationExpense", "AdjustmentsForDepreciationAndAmortisationExpense"];
// 현금흐름 조정에서 따로 적은 사용권자산·투자부동산 감가상각 — 감가상각비에 더한다(2026-10-02). 한국 EV 는 리스부채를 차입금에 넣으므로
// (IFRS 16 — 리스료가 영업이익 아래로) EBITDA 감가상각에도 사용권자산 상각이 들어가야 정의가 맞다. HD현대일렉트릭 2023: 유형 33,109 +
// 사용권 11,271 + 투자부동산 31, 첫 줄만 읽어 1/4 이 빠졌다(한화에어로스페이스 사용권자산상각비 36,476 도)
// [dart 표준 태그, 없을 때 회사 고유 태그] — 현대로템은 사용권자산 상각을 회사 고유 태그로 단다
// (entity00302926:AdjustmentForAmortisationOfRightOfUseAssets… 8,170 — 원문 31,306 + 8,170 + 129 = 39,605 와 일치)
const DEP_EXTRA = [
  ["AdjustmentsForDepreciationRightofuseAssets", /^Adjustments?For(?:Depreciation|Amorti[sz]ation)\w*?Right[Oo]f[Uu]seAssets/],
  ["AdjustmentsForDepreciationInvestmentProperty", /^Adjustments?ForDepreciation\w*?InvestmentPropert/],
];
/** 회사 고유(entity…) 태그 중 이름이 맞는 첫 값 */
function pickEntity(xml, nameRe, prefix) {
  for (const m of xml.matchAll(/<entity\d+:(\w+)\b[^>]*contextRef="([^"]+)"[^>]*>(-?\d+(?:\.\d+)?)</g))
    if (nameRe.test(m[1]) && ctxOk(m[2], prefix)) return Number(m[3]);
  return null;
}
const AMO_C = ["AdjustmentsForAmortisationExpense"];

function ctxOk(ctx, prefix) {
  if (!ctx.startsWith(prefix + "_") && ctx !== prefix) return false;
  if (!ctx.includes("_ConsolidatedMember")) return false;
  if (/SegmentConsolidationItemsAxis|OperatingSegments|ClassesOfAssets|ClassesOfPropertyPlantAndEquipment|ClassesOfIntangibleAssets/.test(ctx))
    return false;
  return /ConsolidatedMember$/.test(ctx) || /ReportedAmountMember$/.test(ctx);
}
function pick(xml, concepts, prefix) {
  for (const c of concepts) {
    const re = new RegExp(`<(?:ifrs-full|dart):${c}\\b[^>]*contextRef="([^"]+)"[^>]*>(-?\\d+(?:\\.\\d+)?)</`, "g");
    let m;
    while ((m = re.exec(xml))) if (ctxOk(m[1], prefix)) return Number(m[2]);
  }
  return null;
}

// ── 사업보고서 원문(연결감사보고서) 현금흐름 조정 주석 — XBRL 에 주석 태깅이 없는 해(2021 이전 보고서 등). "주석에 없을리가 없다"(오너, 2026-10-02):
//    연결현금흐름표의 "비현금항목 조정"·"영업으로부터 창출된 현금흐름" 주석 표의 감가상각비·무형자산상각비 줄. XBRL 이 있는 해(삼성전자 2022~2024,
//    LG화학 2023, SK 2023)와 값이 같음을 확인
const clean = (t) => t.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&cr;|&amp;/g, " ").replace(/\s+/g, " ").trim();
const UNIT = { 원: 1, 천원: 1e3, 백만원: 1e6, 억원: 1e8 };
const UNIT_RE = /단위\s*:\s*(원|천원|백만원|억원)/;
const numOf = (t) => {
  const u = t.replace(/\s/g, "");
  if (!/^\(?-?[\d,]+\)?$/.test(u)) return null;
  const neg = u.startsWith("(") || u.startsWith("-");
  const v = Number(u.replace(/[(),-]/g, ""));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
};
/** 문서에서 현금흐름 조정 표(감가상각비 줄)를 찾아 [당기, 전기] */
function parseDocDa(xml) {
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    const html = m[0];
    const rows = [...html.matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
    // 줄 이름 앞 기호("- 감가상각비" — LG화학) 떼고 공백·괄호 제거
    const label = (r) => (r[0] ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s|\(.*?\)/g, "");
    // 감가상각비(또는 유형자산상각비) + 따로 적은 사용권자산·투자부동산 상각 줄의 합(SK하이닉스 2021 "유형자산상각비·투자부동산상각비",
    // HD현대일렉트릭 "유형자산감가상각비·투자부동산감가상각비·사용권자산감가상각비" — 무형자산상각비는 따로). 같은 이름 줄이 둘이면 첫 줄만
    // 괄호로 자산을 밝힌 줄도(효성중공업 "감가상각비(유형자산)·감가상각비(투자부동산)·감가상각비(사용권자산)" — 괄호를 지우면 셋 다 같은 이름)
    const raw = (r) => (r[0] ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s/g, "");
    const kindOf = (r) => {
      const t = raw(r);
      if (/^(유형자산(감가)?상각비|감가상각비\(유형자산\))$/.test(t)) return "base";
      if (/^(투자부동산(감가)?상각비|감가상각비\(투자부동산\))$/.test(t)) return "inv";
      if (/^(사용권자산(감가)?상각비|감가상각비\(사용권자산\))$/.test(t)) return "rou";
      return label(r) === "감가상각비" && !/\((투자부동산|사용권자산)\)/.test(t) ? "base" : null;
    };
    const byKind = new Map();
    for (const r of rows) { const k = kindOf(r); if (k && !byKind.has(k)) byKind.set(k, r); }
    if (!byKind.has("base")) continue;
    const depRows = [...byKind.values()];
    const names = rows.map(label).join("|");
    const before = clean(xml.slice(Math.max(0, m.index - 1500), m.index));
    const head = before.slice(-300);
    // 현금흐름 조정 표 — 표 앞 제목이나 조정 항목 줄로 판별. 비용 분류·판관비 표는 제외
    const isCf = (/현금흐름/.test(head) && /창출|조정|영업활동/.test(head)) || /조정항목|배당금수익|이자수익|법인세비용|유형자산처분/.test(names);
    // 비용 항목 줄(복리후생비 등)이 있으면 성격별 비용 표로 보고 거르되, 현금흐름 조정 표라는 근거가 뚜렷하면 그대로(한화오션 조정 표에
    // "복리후생비" 줄이 있다 — 2026-10-02)
    const strongCf = (/현금흐름/.test(head) && /창출|조정/.test(head)) || (/조정항목|법인세비용/.test(names) && /처분/.test(names));
    if (!isCf || (!strongCf && /복리후생비|광고선전비|외주용역비|운반보관비/.test(names))) continue;
    const amo = rows.find((r) => /^무형자산상각비$/.test(label(r)));
    // 단위 — 표 안 첫 줄("(단위: 백만원)")이 우선, 없으면 표 바로 앞 문장
    const u = clean(html).match(UNIT_RE)?.[1] ?? [...before.matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
    if (!u) continue;
    // 숫자 칸만(주석 번호 칸 등 제외) — "-" 는 0
    const nums = (r) => r.slice(1).map((c) => (/^[-–]$/.test(c.trim()) ? 0 : numOf(c))).filter((v) => v != null);
    const cols = Math.min(...depRows.map((r) => nums(r).length));
    const dep = Array.from({ length: cols }, (_, i) => depRows.reduce((a, r) => a + nums(r)[i], 0));
    const part = (k) => (byKind.has(k) ? nums(byKind.get(k)).map((v) => v * UNIT[u]) : null);
    return {
      unit: UNIT[u],
      dep: dep.map((v) => v * UNIT[u]),
      amo: amo ? nums(amo).map((v) => v * UNIT[u]) : [],
      parts: { base: part("base"), inv: part("inv"), rou: part("rou") },
    };
  }
  return null;
}
/** 원문 [col] 열이 XBRL 값과 같은가 — 원문 표시 단위(백만원·천원) 반올림 이내. 무형자산상각비는 둘 다 있을 때만 비교 */
function docAgrees(d, col, x) {
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < d.unit;
  if (!near(d.dep[col], x.depreciation)) return false;
  return d.amo[col] == null || x.amortisation == null || near(d.amo[col], x.amortisation);
}
/** 사업보고서 원문 — 연결감사보고서 파일의 첫 현금흐름 조정 표 */
async function docDa(rcpNo) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
  if (!res.ok) throw new Error(`document ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  for (const b of Object.values(files)) {
    // 인코딩 — 선언은 늘 utf-8 이지만 2021 이전 문서는 실제 EUC-KR(실측). UTF-8 로 읽어 깨진 글자가 많으면 EUC-KR
    let x = new TextDecoder("utf-8").decode(b);
    if ((x.match(/�/g) ?? []).length > 50) x = new TextDecoder("euc-kr").decode(b);
    if (!/연결감사보고서/.test(clean(x.slice(0, 3000)))) continue;
    const t = parseDocDa(x);
    if (t) return t;
  }
  return null;
}

/** 한 보고서에서 당기·전기 2개년. */
function fromReport(xml, year) {
  const out = {};
  for (const [y, prefix] of [
    [year, `CFY${year}dFY`],
    [year - 1, `PFY${year - 1}dFY`],
  ]) {
    const d0 = pick(xml, DEP_C, prefix);
    const [rou, inv] = DEP_EXTRA.map(([c, ent]) => pick(xml, [c], prefix) ?? pickEntity(xml, ent, prefix));
    // 기본 감가상각 줄이 없으면 부분합(사용권자산만)이 되므로 비운다 — 원문 주석으로 채움(한화에어로스페이스 2024·2025)
    const d = d0 == null ? null : d0 + (rou ?? 0) + (inv ?? 0);
    const a = pick(xml, AMO_C, prefix);
    if (d != null || a != null) out[y] = { depreciation: d, amortisation: a, xp: { base: d0, rou, inv } };
  }
  return out;
}

async function daByYear(corp) {
  const now = new Date();
  // 최신 확정 사업연도 탐색
  let latest = 0;
  const rcps = {};
  for (const y of [now.getFullYear() - 1, now.getFullYear() - 2]) {
    rcps[y] = await annualRcps(corp, y);
    if (rcps[y].length) { latest = y; break; }
  }
  if (!latest) return null;
  const byYear = {};
  // XBRL 값을 낸 보고서 [보고서 연도, 열(0 당기·1 전기)] — 원문 대조는 같은 보고서·열로(한화에어로스페이스 2022 XBRL 은 2023 보고서 전기
  // 열 = 재작성본 141,845 · 2022 원 보고서 원문은 139,257 — 기준이 다른 비교로 검증 실패가 났다)
  const srcOf = {};
  // XBRL 감가상각 구성(기본·사용권자산·투자부동산) — 원문에서 빠진 줄을 보완할 때
  const xbrlParts = {};
  // 보고서 연도별 원문(정정본에 감사보고서가 없으면 원본) — 한 번만 받는다
  const docCache = {};
  const docOf = async (ry) => {
    if (ry in docCache) return docCache[ry];
    docCache[ry] = null;
    for (const rcp of [...(rcps[ry] ?? [])].reverse()) {
      try {
        const t = await docDa(rcp);
        if (t) { docCache[ry] = t; break; }
      } catch (e) {
        console.log(`    (${ry} ${rcp} 원문 실패: ${e.message})`);
      }
    }
    return docCache[ry];
  };
  // 매년 보고서(최신부터 — 겹치는 해는 최신 보고서 값). 2년 간격이면 2022 보고서를 건너뛰어 2021 값(2022 보고서 전기)이 빠졌다 —
  // 2021 보고서 XBRL 은 주석 태깅 자체가 없다(삼성전자 실측 2026-10-02)
  for (let y = latest; y >= latest - 5; y -= 1) {
    rcps[y] ??= await annualRcps(corp, y);
    // 정정본 XBRL 에 그 해 값이 없으면 다음(원본) 접수본
    for (const rcp of rcps[y]) {
      try {
        const part = fromReport(await loadXbrl(rcp), y);
        for (const [k, { xp, ...v }] of Object.entries(part))
          if (!(k in byYear)) { byYear[k] = { ...v, src: "xbrl" }; srcOf[k] = [y, Number(k) === y ? 0 : 1]; xbrlParts[k] = xp; }
        if (y in part) break;
      } catch (e) {
        console.log(`    (${y} ${rcp} XBRL 실패: ${e.message})`);
      }
    }
  }
  // XBRL 에 조정 태그가 없는 사용권자산·투자부동산 감가상각 줄 — 원문 현금흐름 조정 표에서 보완(한화오션: "사용권자산상각비 23,822" 줄에
  // 조정 태그가 없고 주석 변동표에만 있다). 원문의 기본 감가상각 줄이 XBRL 기본 줄과 같을 때만(같은 표라는 근거) 그 해에 원문 줄을 더한다.
  // 원문을 매번 받지 않도록 최신 XBRL 해에서 원문에 XBRL 이 없는 줄이 보일 때만 전 해를 본다
  {
    const near = (d, a, b) => a != null && b != null && Math.abs(a - b) < d.unit;
    const missing = (y, d, col) => ["rou", "inv"].filter((k) => xbrlParts[y]?.[k] == null && d?.parts[k]?.[col] != null);
    const xys = Object.keys(xbrlParts).map(Number).filter((y) => xbrlParts[y]?.base != null).sort((a, b) => b - a);
    const probe = xys[0] != null ? await docOf(srcOf[xys[0]][0]) : null;
    if (probe && missing(xys[0], probe, srcOf[xys[0]][1]).length) {
      for (const y of xys) {
        const [ry, col] = srcOf[y];
        const d = await docOf(ry);
        const add = missing(y, d, col);
        if (!add.length) continue;
        if (!near(d, d.parts.base[col], xbrlParts[y].base)) {
          console.log(`    (${y} 원문 기본 감가상각 ${d.parts.base[col]} ≠ XBRL ${xbrlParts[y].base} — ${add.join("·")} 보완 안 함)`);
          continue;
        }
        byYear[y].depreciation += add.reduce((a, k) => a + d.parts[k][col], 0);
        byYear[y].src = "xbrl+doc";
      }
    }
  }
  // 점검(--check): XBRL 이 있는 해도 원문 주석을 읽어 같은지 대조(원문 파서 검증 — DB 는 쓰지 않음)
  if (CHECK) {
    for (const y of Object.keys(byYear).map(Number)) {
      const [ry, col] = srcOf[y];
      const d = await docOf(ry);
      const x = byYear[y];
      const ok = d && docAgrees(d, col, x);
      console.log(`    점검 ${y}(${ry} 보고서 ${col ? "전기" : "당기"}): XBRL 감가 ${x.depreciation}/무형 ${x.amortisation} · 원문 ${d ? `${d.dep[col]}/${d.amo[col] ?? null}` : "없음"} ${ok ? "일치" : "불일치"}`);
    }
  }
  // XBRL 로 못 채운 해(감가상각비 없음 포함) — 그 해(없으면 이듬해 보고서의 전기 열) 사업보고서 원문 주석. 원문 파서는 회사마다 표 구성이
  // 달라 다른 표를 잡거나(SK스퀘어·LS — 종속회사 요약 표) 정의가 다를 수 있어(HD현대일렉트릭 원문 감가상각비 > XBRL), 그 회사의 XBRL 해 중
  // 가장 오래된 해에서 원문 값이 XBRL 과 같을 때(단위 반올림 이내)만 쓴다 — 전 유니버스 점검(2026-10-02): 114건 정확 일치, 어긋난 회사는 채우지 않음
  const gaps = [];
  for (let y = latest; y >= latest - 5; y -= 1) if (!(y in byYear) || byYear[y].depreciation == null) gaps.push(y);
  let trusted = false;
  if (gaps.length) {
    const yv = Object.keys(byYear).map(Number).filter((y) => byYear[y].depreciation != null).sort((a, b) => a - b)[0];
    const [ry, col] = yv ? srcOf[yv] : [null, 0];
    const d = yv ? await docOf(ry) : null;
    trusted = !!d && docAgrees(d, col, byYear[yv]);
    if (!trusted) console.log(`    (원문 파서 검증 실패 — ${yv ?? "XBRL 해 없음"} XBRL 감가 ${yv ? byYear[yv].depreciation : "-"} vs 원문(${ry} 보고서) ${d?.dep[col] ?? "없음"}: 빈 해 ${gaps.join("·")} 채우지 않음)`);
  }
  for (const y of trusted ? gaps : []) {
    // 이듬해 보고서 전기 열(재작성본 — XBRL 과 같은 "최신 보고서 우선") → 그 해 보고서 당기 열
    for (const [ry, col] of [[y + 1, 1], [y, 0]]) {
      if (byYear[y]?.depreciation != null || ry > latest) continue;
      rcps[ry] ??= await annualRcps(corp, ry);
      const t = await docOf(ry);
      if (t && t.dep[col] != null)
        byYear[y] = { depreciation: t.dep[col], amortisation: byYear[y]?.amortisation ?? t.amo[col] ?? null, src: y in byYear ? "xbrl+doc" : "doc" };
    }
    if (byYear[y]?.depreciation == null) console.log(`    (${y} 감가상각비 — XBRL·원문 주석 모두 못 찾음)`);
  }
  return Object.keys(byYear).length ? byYear : null;
}

const cli = new MongoClient(URI);
await cli.connect();
const db = cli.db(DB);
let symbols = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// 유니버스는 계정별 문서라 같은 종목이 여러 번 — 중복 제거
if (symbols.length === 0)
  symbols = [...new Set((await db.collection("universe_items").find({ market: "kr" }).toArray()).map((d) => d.symbol))];
console.log(`대상 ${symbols.length}종목`);

const t = (n) => (n == null ? "-" : (n / 1e12).toFixed(2) + "조");
for (const sym of symbols) {
  const corp = corpOf(sym);
  if (!corp) { console.log(`  ${sym}: corp_code 없음`); continue; }
  let byYear = null;
  try { byYear = await daByYear(corp); } catch (e) { console.log(`  ${sym}: ${e.message}`); }
  if (!byYear) { console.log(`  ${sym}: D&A 없음`); continue; }
  if (!CHECK) await db.collection("kr_da").replaceOne(
    { _id: sym },
    { _id: sym, byYear, updatedAt: new Date().toISOString() },
    { upsert: true },
  );
  const yrs = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const y = yrs[0];
  console.log(`  ${sym}  ${yrs.length}개년 (${yrs.at(-1)}~${y})  ` + yrs.map((k) => `${k}:${byYear[k].src} 감가 ${t(byYear[k].depreciation)}/무형 ${t(byYear[k].amortisation)}`).join("  "));
}
await cli.close();
console.log("완료");
