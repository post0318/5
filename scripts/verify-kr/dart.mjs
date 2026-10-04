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
      /** 기간이 가장 늦은 정기보고서(정정본 접수일이 아니라 보고 기간 기준) */
      latestPeriod() {
        const ord = { "11013": 1, "11012": 2, "11014": 3, "11011": 4 };
        return [...latestMap.values()].sort((a, b) => b.year - a.year || ord[b.code] - ord[a.code])[0] ?? null;
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
