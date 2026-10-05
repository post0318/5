/**
 * 검증기 DART 원자료 조회(한국) — 앱 코드와 무관하게 OpenDART 를 직접 부른다.
 *
 * 디스크 캐시(cache.mjs) 열쇠 = 그 보고서의 **최신 접수번호**. 회사마다 실행당 1회 정기공시 목록(list.json)을 받아
 * (사업연도·보고서 코드) → 최신 접수번호를 정하고, 같으면 디스크, 바뀌었으면(정정 공시) 새로 받는다. 목록 자체는 캐시하지 않는다.
 * "013 자료 없음"도 그때의 판본("none" 또는 접수번호)과 함께 캐시 — 다음 실행 때 목록에 보고서가 생기면 판본이 달라져 무효.
 * 요청은 전부 한 줄로(간격 300ms) — 몰아 보내면 이 PC·서버 연결이 약 1시간 막힌다(실측 2026-10-01).
 * 조회 실패는 캐시하지 않고 던진다(호출부가 실패·종료코드 1).
 */
import { unzipSync, strFromU8 } from "fflate";

const B = "https://opendart.fss.or.kr/api";
let KEY = null, CACHE = null;
let chain = Promise.resolve();
const slot = () => (chain = chain.then(() => new Promise((r) => setTimeout(r, 300))));
export const dartStats = { requests: 0 };

export function configureDart({ key, cache }) {
  KEY = key;
  CACHE = cache;
}

async function getRaw(url, kind) {
  if (!KEY) throw new Error("DART_API_KEY 미설정");
  for (let i = 0; ; i++) {
    try {
      await slot();
      dartStats.requests++;
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`DART ${kind} HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
  }
}

async function getJson(path, params, kind) {
  const q = new URLSearchParams({ crtfc_key: KEY ?? "", ...params });
  const r = await getRaw(`${B}/${path}?${q}`, kind);
  const j = await r.json();
  if (j.status === "013") return { status: "013", list: null };
  if (j.status !== "000") throw new Error(`DART ${kind} ${j.status} ${j.message ?? ""}`.trim());
  return j;
}

// ── 정기공시 목록(실행당 회사별 1회, 캐시 안 함) ──
const listMemo = new Map();
const RE_NM = /(사업|반기|분기)보고서\s*\((\d{4})\.(\d{2})\)/;
/**
 * 회사의 정기공시 — reports: [{ year, code, month, rcept, nm }] (정정본 포함), latest(year, code) = 최신 접수번호.
 * code: 11011 사업 · 11012 반기 · 11013 1분기 · 11014 3분기(결산월 기준 3·6·9개월째)
 */
export function dartList(corp) {
  if (!listMemo.has(corp)) listMemo.set(corp, (async () => {
    const cy = new Date().getFullYear();
    const end = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const j = await getJson("list.json", { corp_code: corp, bgn_de: `${cy - 8}0101`, end_de: end, pblntf_ty: "A", page_count: "100", page_no: String(page) }, "list.json");
      if (j.status === "013") break;
      rows.push(...(j.list ?? []));
      if (page >= Number(j.total_page ?? 1)) break;
    }
    const raw = rows.map((r) => ({ m: RE_NM.exec(r.report_nm ?? ""), r })).filter((x) => x.m);
    // 결산월 = 사업보고서의 월(가장 흔한 값)
    const am = raw.filter((x) => x.m[1] === "사업").map((x) => Number(x.m[3]));
    const fyMonth = am.length ? am.sort((a, b) => am.filter((v) => v === b).length - am.filter((v) => v === a).length)[0] : 12;
    const reports = [];
    for (const { m, r } of raw) {
      const yy = Number(m[2]), mm = Number(m[3]);
      let code = null, year = yy;
      if (m[1] === "사업") code = "11011";
      else {
        const off = (mm - fyMonth + 12) % 12;
        code = { 3: "11013", 6: "11012", 9: "11014" }[off] ?? null;
        // 결산월이 12월이 아니면 사업연도 = 결산월 이후 시작 연도 — 12월 결산만 확정 처리, 나머지는 판본 미상(캐시 안 함)
        if (fyMonth !== 12) code = null;
      }
      if (!code) continue;
      reports.push({ year, code, month: mm, rcept: r.rcept_no, nm: r.report_nm, dt: r.rcept_dt });
    }
    const latestMap = new Map();
    for (const x of reports) {
      const k = `${x.year}|${x.code}`;
      if (!latestMap.has(k) || latestMap.get(k).rcept < x.rcept) latestMap.set(k, x);
    }
    return {
      fyMonth,
      reports,
      latest: (year, code) => latestMap.get(`${year}|${code}`) ?? null,
      /**
       * 기간이 가장 늦은 정기보고서(정정본 접수일이 아니라 보고 기간 기준). 시험 스위치 KR_VERIFY_ASSUME_ANNUAL=1 이면 사업보고서만(3~5월 —
       * 최신 정기보고서가 사업보고서인 시기를 흉내, 감사 2차 ⑤)
       */
      latestPeriod() {
        const ord = { "11013": 1, "11012": 2, "11014": 3, "11011": 4 };
        const vs = [...latestMap.values()].filter((x) => process.env.KR_VERIFY_ASSUME_ANNUAL !== "1" || x.code === "11011");
        return vs.sort((a, b) => b.year - a.year || ord[b.code] - ord[a.code])[0] ?? null;
      },
    };
  })());
  return listMemo.get(corp);
}

async function versioned(ns, key, ver, fetcher) {
  if (ver != null && CACHE) {
    const hit = CACHE.get(ns, key, ver);
    if (hit !== undefined) return hit;
  }
  const v = await fetcher();
  if (ver != null && CACHE) CACHE.put(ns, key, ver, v);
  return v;
}

/** 전체 재무제표(fnlttSinglAcntAll) — 목록(list) 또는 null(013). 판본 = 그 보고서 최신 접수번호(없으면 "none") */
export async function dartFnltt(corp, year, reprt, fsDiv) {
  const L = await dartList(corp);
  const ver = L.fyMonth === 12 ? (L.latest(year, reprt)?.rcept ?? "none") : null;
  return versioned("fnltt", `${corp}_${year}_${reprt}_${fsDiv}`, ver, async () => {
    const j = await getJson("fnlttSinglAcntAll.json", { corp_code: corp, bsns_year: String(year), reprt_code: reprt, fs_div: fsDiv }, `fnltt ${year} ${reprt} ${fsDiv}`);
    return j.list ?? null;
  });
}

/** 배당에 관한 사항(alotMatter) — 목록 또는 null */
export async function dartAlot(corp, year, reprt = "11011") {
  const L = await dartList(corp);
  const ver = L.fyMonth === 12 ? (L.latest(year, reprt)?.rcept ?? "none") : null;
  return versioned("alot", `${corp}_${year}_${reprt}`, ver, async () => {
    const j = await getJson("alotMatter.json", { corp_code: corp, bsns_year: String(year), reprt_code: reprt }, `alotMatter ${year}`);
    return j.list ?? null;
  });
}

// XBRL 원본은 크다(수 MB) — 필요한 사실만 텍스트(JSON)로 남긴다. 거르는 규칙이 바뀌면 FILTER 판을 올려 옛 캐시를 무효로
const XBRL_FILTER_VER = "f2";
const XBRL_KEEP = /Lease|Depreciat|Amorti[sz]|RightofuseAssets|RightOfUseAssets|InvestmentPropert|Impairment/i;
/** 보고서 XBRL 의 숫자 사실 중 감가상각·리스 관련만 [개념, 컨텍스트, 값]. 판본 = 접수번호(바뀌지 않음) */
export async function dartXbrlFacts(rcept, reprt) {
  return versioned("xbrl", `${rcept}_${reprt}`, `${rcept}-${XBRL_FILTER_VER}`, async () => {
    const r = await getRaw(`${B}/fnlttXbrl.xml?crtfc_key=${KEY}&rcept_no=${rcept}&reprt_code=${reprt}`, `XBRL ${rcept}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 100) throw new Error(`DART XBRL ${rcept} 빈 응답(${buf.length}B)`);
    let files;
    try { files = unzipSync(buf); } catch (e) { throw new Error(`DART XBRL ${rcept} 압축 해제 실패 — ${strFromU8(buf.slice(0, 200)).replace(/\s+/g, " ").slice(0, 120)}`, { cause: e }); }
    const n = Object.keys(files).find((x) => x.endsWith(".xbrl"));
    if (!n) throw new Error(`DART XBRL ${rcept} — zip 안에 .xbrl 없음`);
    const xml = strFromU8(files[n]);
    const out = [];
    for (const m of xml.matchAll(/<([\w-]+):(\w+)\b[^>]*?contextRef="([^"]+)"[^>]*>(-?\d+(?:\.\d+)?)</g))
      if (XBRL_KEEP.test(m[2]) || /Lease/i.test(m[3])) out.push([`${m[1]}:${m[2]}`, m[3], Number(m[4])]);
    return out;
  });
}

const DOC_FILTER_VER = "d1";
/** 보고서 원문 중 "리스부채" 가 들어간 문장만(회계정책 — 리스부채를 어느 재무상태표 줄에 표시하는가). 판본 = 접수번호 */
export async function dartDocLeaseSentences(rcept) {
  return versioned("doc-lease", rcept, `${rcept}-${DOC_FILTER_VER}`, async () => {
    const r = await getRaw(`${B}/document.xml?crtfc_key=${KEY}&rcept_no=${rcept}`, `원문 ${rcept}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    // 원문 파일이 없는 판본(DART 014 "파일이 존재하지 않습니다" — [첨부정정]은 첨부만 바꿔 본문이 없다, 001440 2024)은 문장 없음. 다른 상태는 실패
    const head = strFromU8(buf.slice(0, 300));
    if (/^<\?xml/.test(head) && /<status>014<\/status>/.test(head)) return [];
    let files;
    try { files = unzipSync(buf); } catch (e) { throw new Error(`DART 원문 ${rcept} 압축 해제 실패 — ${strFromU8(buf.slice(0, 200)).replace(/\s+/g, " ").slice(0, 120)}`, { cause: e }); }
    const out = new Set();
    for (const b of Object.values(files)) {
      let t = new TextDecoder("utf-8").decode(b);
      if (/�/.test(t.slice(0, 20000))) t = new TextDecoder("euc-kr").decode(b);
      t = t.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
      for (const s of t.split(/(?<=[.다])\s/)) if (s.includes("리스부채") && s.length < 400) out.add(s.trim());
    }
    return [...out];
  });
}

const DOC_CELL_VER = "c2";
const CELL_UNIT = { 원: 1, 천원: 1e3, 백만원: 1e6, 억원: 1e8 };
/**
 * 분기·반기 보고서 원문 주석 표의 태그 칸(리스부채 관련 — ACODE·ACONTEXT 가 달린 <TE>) → [개념, 컨텍스트, 원 단위 값]. 표 단위("(단위 : 천원)")는
 * 그 표 안 첫 부분, 없으면 표 바로 앞 글자의 마지막 단위 표기. ADECIMAL 이 표 단위와 맞지 않는 칸(0 제외)은 버린다. 판본 = 접수번호
 */
export async function dartDocLeaseCells(rcept) {
  return versioned("doc-lease-cells", rcept, `${rcept}-${DOC_CELL_VER}`, async () => {
    const r = await getRaw(`${B}/document.xml?crtfc_key=${KEY}&rcept_no=${rcept}`, `원문 ${rcept}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const head = strFromU8(buf.slice(0, 300));
    if (/^<\?xml/.test(head) && /<status>014<\/status>/.test(head)) return [];
    let files;
    try { files = unzipSync(buf); } catch (e) { throw new Error(`DART 원문 ${rcept} 압축 해제 실패 — ${strFromU8(buf.slice(0, 200)).replace(/\s+/g, " ").slice(0, 120)}`, { cause: e }); }
    const strip = (t) => t.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
    const unitIn = (t) => [...strip(t).matchAll(/단위\s*:\s*(천원|백만원|억원|원)/g)].map((m) => m[1]);
    const out = [];
    for (const b of Object.values(files)) {
      let t = new TextDecoder("utf-8").decode(b);
      if (/�/.test(t.slice(0, 20000))) t = new TextDecoder("euc-kr").decode(b);
      const re = /<TABLE[\s\S]*?<\/TABLE>/gi;
      let m;
      while ((m = re.exec(t))) {
        const tab = m[0];
        const u = CELL_UNIT[unitIn(tab.slice(0, 2000))[0] ?? unitIn(t.slice(Math.max(0, m.index - 1500), m.index)).at(-1)];
        if (!u) continue;
        for (const c of tab.matchAll(/<TE\s([^>]*)>([^<]*)<\/TE>/g)) {
          const attr = (n) => new RegExp(`(?:^|\\s)${n}="([^"]*)"`).exec(c[1])?.[1];
          const code = attr("ACODE"), ctx = attr("ACONTEXT"), dec = attr("ADECIMAL");
          if (!code || !ctx || !/Lease|LiabilitiesArisingFromFinancingActivities|FinancialLiabilities/.test(code + ctx)) continue;
          const raw = c[2].replace(/[　\s]/g, "");
          if (!/^\(?-?[\d,]+\)?$/.test(raw)) continue;
          const val = Number(raw.replace(/[(),-]/g, "")) * (/^[(-]/.test(raw) ? -1 : 1);
          if (dec != null && /^-?\d+$/.test(dec) && val !== 0 && 10 ** -Number(dec) !== u) continue;
          out.push([code, ctx, val * u]);
        }
      }
    }
    return out;
  });
}

/** 기업개황(company.json) — 법인등록번호(jurir_no) 등. 판본 고정(v1, 법인등록번호는 바뀌지 않음) */
export async function dartCompany(corp) {
  return versioned("company", corp, "v1", async () => {
    const j = await getJson("company.json", { corp_code: corp }, `company ${corp}`);
    return { jurir_no: j.jurir_no ?? null, corp_name: j.corp_name ?? null };
  });
}

const DOC_DA_VER = "t4";
/**
 * 보고서 원문(사업·분기·반기)의 표 중 감가상각·상각 줄이 있는 표만 — [{ head, unit, scope, section, period, rows: [[셀…]] }].
 *  · head = 표 바로 앞 글자 마지막 300자, unit = 원 단위 배수(표 안 첫 부분 → 없으면 표 앞 1500자의 마지막 "(단위 : …)")
 *  · section = 표가 속한 주석 제목(문서 순서로 표 사이 글자에 나온 마지막 "번호. 제목" — 제목이 없는 표는 앞 표의 제목을 잇는다: 당반기 표 뒤의
 *    전반기 표 등). 감사 3차: 범위·표 종류(성격별·현금흐름)를 이 제목으로 판정한다
 *  · scope = 연결("con")·별도("sep")·미상(null) — 첨부 문서 종류(연결감사보고서 00761 → con, 감사보고서 00760 → sep) → 본문 목차(<TITLE>)가
 *    "연결재무제표…"면 con, "재무제표…"면 sep → 주석 제목에 "연결"이 있으면 con(「반기연결현금흐름표」·「비용의 성격별 분류 (연결)」), 제목은 있는데
 *    "연결"이 없으면 sep(「현금흐름표」). 셋 다 못 정하면 null
 *  · period = 표 바로 앞(제목 뒤) 기간 표시 — "cur"(당기·당반기·당분기)·"prior"(전기·전반기·전분기)·null
 *  · rows 의 셀은 COLSPAN 만큼 반복(머리행 열 맞춤용)
 * 앱 적재 스크립트(populate-kr-da.mjs)와 코드를 나누지 않는 검증기 판독. 판본 = 접수번호
 */
export async function dartDocDaTables(rcept) {
  return versioned("doc-da-tables", rcept, `${rcept}-${DOC_DA_VER}`, async () => {
    const r = await getRaw(`${B}/document.xml?crtfc_key=${KEY}&rcept_no=${rcept}`, `원문 ${rcept}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const head = strFromU8(buf.slice(0, 300));
    if (/^<\?xml/.test(head) && /<status>014<\/status>/.test(head)) return [];
    let files;
    try { files = unzipSync(buf); } catch (e) { throw new Error(`DART 원문 ${rcept} 압축 해제 실패 — ${strFromU8(buf.slice(0, 200)).replace(/\s+/g, " ").slice(0, 120)}`, { cause: e }); }
    const U = { 원: 1, 천원: 1e3, 백만원: 1e6, 억원: 1e8 };
    const txt = (t) => t.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&cr;|&amp;/g, " ").replace(/\s+/g, " ").trim();
    const units = (t) => [...txt(t).matchAll(/단위\s*:\s*(천원|백만원|억원|원)/g)].map((m) => U[m[1]]);
    const out = [];
    for (const b of Object.values(files)) {
      let t = new TextDecoder("utf-8").decode(b);
      if ((t.match(/�/g) ?? []).length > 50) t = new TextDecoder("euc-kr").decode(b);
      const acode = t.match(/<DOCUMENT-NAME[^>]*ACODE="(\d+)"/)?.[1];
      const fileScope = acode === "00761" ? "con" : acode === "00760" ? "sep" : null;
      const titles = [...t.matchAll(/<TITLE[^>]*>([^<]*)<\/TITLE>/g)].map((x) => [x.index, x[1]]);
      const titleScope = (i) => {
        const ti = titles.filter(([k]) => k < i).at(-1)?.[1] ?? "";
        return /연결\s*재무제표/.test(ti) ? "con" : /재무제표/.test(ti) ? "sep" : null;
      };
      const re = /<TABLE[\s\S]*?<\/TABLE>/gi;
      let m, prevEnd = 0, section = null;
      while ((m = re.exec(t))) {
        const tab = m[0];
        // 앞 자료 표(3줄 이상) 뒤부터 이 표까지의 글자 — 제목·단위만 담은 작은 표(DART 는 "당기 (단위 : 천원)"를 따로 작은 표에 넣는다)도 포함
        const between = txt(t.slice(prevEnd, m.index));
        if ((tab.match(/<TR/gi) ?? []).length >= 3) prevEnd = m.index + tab.length;
        // 마지막 "번호. 제목"(번호 뒤 한글로 시작하는 30자) — 없으면 앞 표 제목을 잇는다
        const hs = [...between.matchAll(/(?:^|\s)(\d{1,2})\.\s*([가-힣][^.]{0,30})/g)];
        if (hs.length) section = hs.at(-1)[2].trim();
        if (!/상각/.test(tab)) continue;
        const rows = [...tab.matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((x) => [...x[0].matchAll(/<T([DHEU])([^>]*)>([\s\S]*?)<\/T[DHEU]>/gi)].flatMap((c) => {
          const span = Number(c[2].match(/COLSPAN="?(\d+)/i)?.[1] ?? 1);
          return Array(Math.min(Math.max(span, 1), 20)).fill(txt(c[3]));
        }));
        if (!rows.some((row) => /상각/.test(row[0] ?? ""))) continue;
        const before = t.slice(Math.max(0, m.index - 1500), m.index);
        const unit = units(tab.slice(0, 2000))[0] ?? units(before).at(-1) ?? null;
        const tail = between.slice(-40).replace(/\s+/g, "");
        const period = /(당|금)(반기|분기|기)(말)?(\(단위[^)]*\))?$/.test(tail) ? "cur" : /전(반기|분기|기)(말)?(\(단위[^)]*\))?$/.test(tail) ? "prior" : null;
        const secScope = section ? (/연결/.test(section) ? "con" : "sep") : null;
        out.push({ head: txt(before).slice(-300), unit, scope: fileScope ?? titleScope(m.index) ?? secScope, section, period, rows });
      }
    }
    return out;
  });
}
