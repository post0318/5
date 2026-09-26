#!/usr/bin/env node
// 심은 오류(mutation) 시험 — 검증기(scripts/verify-financials.mjs)의 검출력(검출률) 측정 (2026-09-26, docs/metrics/mutation.md)
//
// 알려진 오류 유형을 **검증기가 받는 앱 응답**에 심고(검증기 쪽 fetch 가로채기, `node --import` — 앱·운영 DB 는 건드리지 않음),
// 검증기를 돌려 심은 오류가 잡히는지 본다. "잡힘" = 기준선(심기 전)에 없던 FAIL 검사 · ③ 오류(매출·매출원가 외부 대조) · 조회 실패
// (hardErrors)·종목 오류가 새로 생김. ①·②·통과·공통모드·검증불가로 분류되는 것은 잡힘이 아니다.
//
//   node scripts/metrics/mutation.mjs                     전체 목록
//   node scripts/metrics/mutation.mjs --only=M01a,M06b    일부만
//   옵션: --base=http://localhost:3000 · --no-external(외부 대조 끔 — ③ 검출 불가) · --cache=디렉터리(캐시 위치 지정·재사용 → SEC 요청 0, 지우지 않음)
//         --keep-cache(기본 캐시 보존 — 기본은 끝나면 지운다. 공시 원본까지 담겨 7종목에 약 0.7GB)
//         --list(목록만 출력)
//
// 동작
// 1. 종목마다 기준선 1회(심기 없음) → 목록의 심기마다 1회. 모두 같은 프로세스 훅(이 파일을 --import)을 거친다.
// 2. 훅은 모든 외부 응답(SEC·Yahoo·인포맥스·StockAnalysis)과 앱 응답을 이번 실행 캐시에 저장하고, 두 번째부터는 캐시로 답한다 —
//    기준선과 심기 실행이 같은 원자료·같은 앱 응답을 보므로 차이는 심은 오류 때문이다(SEC 부하는 기준선 때만).
// 3. SEC 요청(캐시 없음)은 초당 2건 이하, 429 면 65초 기다렸다 최대 3회 재시도.
// 4. 앱에는 GET 만 보낸다(검증기 --post 경로 차단). 운영 DB 쓰기 없음 — 단 앱 서버가 GET 처리 중 재무 캐시를 저장하는지는 서버 설정
//    (FIN_NO_PERSIST=1 권장)에 달려 있다.
// 결과: reports/mutation/<시각>/ (result.json · result.md · runs/ 검증 결과·로그). 종료코드 1 = 새 공백·심기 실패·기준선 오류.
//
// 목록 추가 규칙(docs/metrics/mutation.md §4): 앞으로 실제로 발견되는 오류는 전부 여기 한 줄로 추가한다. 심는 값은 명시값(from → to)으로 —
// 앱 값이 from 과 다르면 심지 않고 "심기 실패"로 보고한다(엉뚱한 값을 조용히 심지 않게).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
/** 대조군 — 심기 없이 캐시만으로 다시 돌린 실행. 기준선과 달라지면 재현성 문제(검출 판정 불가) */
const CONTROL = "__control";
const ROOT = path.resolve(path.dirname(SELF), "../..");

// ── 심은 오류 목록 ─────────────────────────────────────────────────────────────────────────────────────────────
// 필드: id · cat(범주 번호 1~15) · sym · col(표시 열) · what(무엇을 심나) · origin(실제 사례·근거) · expect(검출해야 할 층, 예 "A")
//       · plants(심기 — replace: 앱 응답 전체에서 숫자 from 과 정확히 같은 값을 to 로. kinds 로 응답 종류 제한 가능 / fn: 구조 변경)
//       · knownGap(문서화된 알려진 공백 사유 — 있으면 미검출이어도 새 공백 아님) · countIf(검출로 셀 검사 범위 — 계측 한계가 있을 때만)
// 응답 종류(kind): hl 하이라이트 · an 재무분석 · ov 개요 · tt TTM · cs 컨센서스 · is/isq 손익(연간/분기) · bs 대차대조표 · sm/smq 총괄
//                  · row verify-row(개요·유니버스 계산 결과)
export const CATEGORIES = {
  1: "매출 +1달러",
  2: "반올림 재태깅 채택",
  3: "판본 오류(재작성 전 값)",
  4: "부호 뒤집힘",
  5: "단위 오류(×1000·÷1000)",
  6: "20-F 환율",
  7: "Q4 파생식(FY − 6개월)",
  8: "LTM 식(전년 누적 기간 오류)",
  9: "매출원가 오판독(주석 조각·임차비용)",
  10: "조용한 대체(경고 없는 다른 값)",
  11: "시가총액 부동소수 잔여",
  12: "주식수 1,000주 차이",
  13: "사유 없는 빈칸",
  14: "빈칸이어야 할 곳에 값",
  15: "화면 간 불일치",
};

/** MCD(유형 D — 본표에 매출원가 줄 없음) 손익계산서에 매출원가·매출총이익 행을 끼워 넣고 "구성 규칙 대기" 각주를 지운다 */
const insertCogsRows = (col, cogs, gp) => (j) => {
  const sec = (j.sections ?? []).find((s) => (s.items ?? []).some((it) => it.accountName === "(−) 영업비용"));
  if (!sec || !(j.periods ?? []).some((p) => p.label === col)) return 0;
  const blank = Object.fromEntries(j.periods.map((p) => [p.label, null]));
  const i = sec.items.findIndex((it) => it.accountName === "(−) 영업비용");
  sec.items.splice(i + 1, 0,
    { accountName: "(−) 매출원가", accountId: "is:(−) 매출원가", depth: 1, isSubtotal: false, isHighlight: false, values: { ...blank, [col]: cogs } },
    { accountName: "매출총이익", accountId: "is:매출총이익", depth: 0, isSubtotal: true, isHighlight: true, values: { ...blank, [col]: gp } });
  sec.items = sec.items.filter((it) => !String(it.accountName).startsWith("※ 매출원가·매출총이익"));
  return 2;
};

// TSM FY2024(2024-01-01 ~ 2024-12-31) — 6b 에서 환율 원천(Yahoo 일별 TWD)이 +0.5% 틀린 경우. 앱 매출 × k, 검증기가 받는 같은 구간 환율 × k
const FX_K = 1.005;
const TSM_REV_2024 = 90303220607.22644;

export const MUTATIONS = [
  { id: "M01a", cat: 1, sym: "KO", col: "2024Y", what: "연간 매출 +1달러", origin: "골든셋 주입 시험(2026-09-26) — 상대 오차 1e-9 가 4천억 달러에서 400달러를 통과시킨 결함",
    expect: "A", plants: [{ op: "replace", from: 47061000000, to: 47061000001 }] },
  { id: "M01b", cat: 1, sym: "KO", col: "2026 Q1", what: "분기 매출 +1달러", origin: "M01a 의 분기판",
    expect: "A", plants: [{ op: "replace", from: 12472000000, to: 12472000001 }] },
  { id: "M02a", cat: 2, sym: "MRVL", col: "2022Y", what: "매출 반올림 재태깅 채택 4,462,383,000 → 4,462,400,000", origin: "MRVL FY2022 — 2023 10-K 가 10만 달러 단위 반올림값으로 재태깅(2026-09-26 발견, 앱·검증기 공통 맹점)",
    expect: "A", plants: [{ op: "replace", from: 4462383000, to: 4462400000 }] },
  { id: "M02b", cat: 2, sym: "MRVL", col: "2022Y", what: "혼합 열 — 매출원가만 반올림값 2,398,158,000 → 2,398,200,000(매출·매출총이익은 정밀값)", origin: "MRVL FY2021/2022 줄 단위 판본 선택 — 열 안에 반올림 줄과 정밀 줄이 섞여 항등식이 깨짐(열 단위 판본 규칙의 계기)",
    expect: "A", plants: [{ op: "replace", from: 2398158000, to: 2398200000 }] },
  { id: "M03a", cat: 3, sym: "DELL", col: "2024Y", what: "순이익 재작성 전 값 3,388,000,000 → 3,211,000,000(10-K 2024-03-25 원공시)", origin: "DELL FY2024 — 10-K 2025-03-25 가 재작성(세전·순이익·매출원가). 최신 판본 규칙 위반 재현",
    expect: "A", plants: [{ op: "replace", from: 3388000000, to: 3211000000 }] },
  { id: "M03b", cat: 3, sym: "DELL", col: "2024Y", what: "열 전체 원공시 — 매출원가 67,356,000,000 → 67,556,000,000, 매출총이익 21,069,000,000 → 20,869,000,000", origin: "DELL FY2024 재작성 전 매출원가(항등식은 성립하게 — 판본만 틀림)",
    expect: "A", plants: [{ op: "replace", from: 67356000000, to: 67556000000 }, { op: "replace", from: 21069000000, to: 20869000000 }] },
  { id: "M04a", cat: 4, sym: "KO", col: "2025Y", what: "매출원가 부호 뒤집힘 18,397,000,000 → −18,397,000,000", origin: "MCD 9개월 영업외손익 163 → −163 부호 관례 재태깅(판본 판정에서 발견)",
    expect: "A", plants: [{ op: "replace", from: 18397000000, to: -18397000000 }] },
  { id: "M04b", cat: 4, sym: "KO", col: "2024Y", what: "영업이익 부호 뒤집힘 9,992,000,000 → −9,992,000,000", origin: "부호 관례 오류 일반형",
    expect: "A", plants: [{ op: "replace", from: 9992000000, to: -9992000000 }] },
  { id: "M05a", cat: 5, sym: "KO", col: "2023Y", what: "매출 ×1000 45,754,000,000 → 45,754,000,000,000", origin: "주식수 단위 오류(MCD 가중평균 716.4 = 7억 1,640만 주 — fixScale)의 금액판",
    expect: "A", plants: [{ op: "replace", from: 45754000000, to: 45754000000000 }] },
  { id: "M05b", cat: 5, sym: "KO", col: "2025Y", what: "자산총계 ÷1000 104,816,000,000 → 104,816,000", origin: "천 단위 표기 원자료를 달러로 오인",
    expect: "A", plants: [{ op: "replace", from: 104816000000, to: 104816000 }] },
  { id: "M06a", cat: 6, sym: "TSM", col: "2024Y", what: "매출 × 1.005 — 앱만 환율 오적용(검증기 환율 원천은 정상)", origin: "20-F 환율 #4·#5(handoff) — 앱이 기간·환율 계열을 잘못 고른 경우",
    expect: "A", plants: [{ op: "replace", from: TSM_REV_2024, to: TSM_REV_2024 * FX_K }] },
  { id: "M06b", cat: 6, sym: "TSM", col: "2024Y", what: "환율 원천 자체 +0.5% — 앱 매출 × 1.005 와 검증기가 받는 Yahoo TWD 일별 환율(FY2024 구간) × 1.005", origin: "20-F 환산 환율은 앱·검증기 모두 Yahoo 일별 — 원천이 틀리면 둘이 같이 틀림",
    expect: "A", knownGap: "공통모드 — 앱·검증기가 같은 Yahoo 환율을 쓴다(20-F 환율 독립 원천 미확보, handoff 남은 순서 3). 외부(인포맥스·StockAnalysis)는 환율 방식이 달라 ② 로 분류",
    countIf: (c) => c.metric === "rev" && ["A", "F"].includes(c.layer),
    countNote: "계측 범위 = 매출 A·F층 — 이 가로채기는 FY2024 구간 환율만 바꾸고 앱은 매출만 바꿔서 다른 지표·파생값(순이익·성장률 등)의 발화는 계측 잡음",
    fx: { cur: "TWD", start: "2024-01-01", end: "2024-12-31", k: FX_K },
    plants: [{ op: "replace", from: TSM_REV_2024, to: TSM_REV_2024 * FX_K }] },
  { id: "M07", cat: 7, sym: "KO", col: "2025 Q4", what: "Q4 = FY − 6개월 11,822,000,000 → 24,277,000,000(47,941 − 23,664)", origin: "revenue.md §2 Q4 = FY − 9개월 규칙의 반대 사례",
    expect: "A", plants: [{ op: "replace", from: 11822000000, to: 24277000000 }] },
  { id: "M08", cat: 8, sym: "KO", col: "LTM", what: "LTM 전년 동기 누적을 2024 H1(23,663)로 — 50,129,000,000 → 50,130,000,000", origin: "XOM LTM — 연간 문장값과 9개월 합계를 섞어 구한 사례(handoff XOM LTM 해결)",
    expect: "A", plants: [{ op: "replace", from: 50129000000, to: 50130000000 }] },
  { id: "M09a", cat: 9, sym: "CAT", col: "2023Y", what: "매출원가 = 주석 조각 160,000,000(42,767,000,000 대신), 매출총이익 합성 66,900,000,000", origin: "cogs.md C1 — CAT FY2022~25 CostOfGoodsAndServicesSold 주석 조각 413/160/33/49백만",
    expect: "A", plants: [{ op: "replace", from: 42767000000, to: 160000000 }, { op: "replace", from: 24293000000, to: 66900000000 }] },
  { id: "M09b", cat: 9, sym: "MCD", col: "2026 Q2", what: "가맹점 임차비용(10-Q 680,000,000)을 매출원가로, 매출총이익 6,419,000,000", origin: "cogs.md C2 — MCD 10-Q 가 가맹점 임차비용을 원가 태그로",
    expect: "A", plants: [{ op: "fn", kinds: ["isq"], name: "매출원가·매출총이익 행 삽입(2026 Q2)", fn: insertCogsRows("2026 Q2", 680000000, 6419000000) }] },
  { id: "M10", cat: 10, sym: "DE", col: "LTM", what: "총차입금 63,836,000,000 → 17,120,000,000(순차입금도 같이 54,908,000,000 → 8,192,000,000), 경고 문구 없음", origin: "handoff 긴급 결함 — SEC Archives 429 때 DE 총차입금 연결 → 장비 부문만으로 조용히 대체",
    expect: "A", plants: [{ op: "replace", from: 63836000000, to: 17120000000 }, { op: "replace", from: 54908000000, to: 8192000000 }] },
  { id: "M11", cat: 11, sym: "KO", col: "FY2025", what: "시가총액 = 4,302,000,000주 × float32 종가(69.91 → 69.91000366210938) 300,752,820,000 → 300,752,835,754.39453", origin: "시가총액 종가 센트 보정(price-tick.ts cleanUsdPrice) 이전 — 146.92 가 146.9199981689453",
    expect: "A", plants: [{ op: "replace", from: 300752820000, to: 300752835754.39453 }] },
  { id: "M12a", cat: 12, sym: "KO", col: "FY2024", what: "결산일 주식수 +1,000주 → 시가총액 267,842,520,000 → 267,842,582,260(+1,000 × 62.26)", origin: "인포맥스 주식수 대조(천 주 단위) — 결산일 주식수 차이",
    expect: "A", plants: [{ op: "replace", from: 267842520000, to: 267842582260 }] },
  { id: "M12b", cat: 12, sym: "KO", col: "현재", what: "현재 주식수 +1,000주 4,302,549,243 → 4,302,550,243(TTM 스냅샷)", origin: "현재 주식수 = EDGAR → 인포맥스 보정 경로",
    expect: "A", plants: [{ op: "replace", from: 4302549243, to: 4302550243 }] },
  { id: "M13", cat: 13, sym: "KO", col: "2022Y", what: "매출 빈칸(사유 없음) 43,004,000,000 → null", origin: "TSM·ASML 연도 열 통째 누락이 통과하던 결함(2026-09-24 재구축)",
    expect: "A", plants: [{ op: "replace", from: 43004000000, to: null }] },
  { id: "M14", cat: 14, sym: "MCD", col: "2025Y", what: "유형 D(구성 규칙 없음)인데 매출원가 14,492,000,000(총영업비용)·매출총이익 12,393,000,000 표시", origin: "cogs.md §3 유형 D — 규칙 대기 중엔 빈칸 + 사유여야 함",
    expect: "A", plants: [{ op: "fn", kinds: ["is"], name: "매출원가·매출총이익 행 삽입(2025Y)", fn: insertCogsRows("2025Y", 14492000000, 12393000000) }] },
  { id: "M15", cat: 15, sym: "KO", col: "FY2024", what: "하이라이트 순이익만 10,631,000,000 → 10,632,000,000(손익계산서는 그대로)", origin: "revenue.md D2 — 화면마다 다른 정의·값(컨센서스·유니버스)",
    expect: "C", plants: [{ op: "replace", kinds: ["hl"], from: 10631000000, to: 10632000000 }] },
];

// ── 응답 종류 판정 ───────────────────────────────────────────────────────────────────────────────────────────────
function kindOf(url) {
  const u = new URL(url);
  const p = u.pathname, v = u.searchParams.get("view"), per = u.searchParams.get("period");
  if (p.startsWith("/api/cron/verify-row")) return "row";
  const m = /^\/api\/markets\/[a-z]+\/[^/]+\/([a-z-]+)$/.exec(p);
  if (!m) return "other";
  if (m[1] === "financials") return v === "analysis" ? "an" : v === "is" ? (per === "quarter" ? "isq" : "is") : v === "summary" ? (per === "quarter" ? "smq" : "sm") : v === "bs" ? "bs" : `fin-${v}`;
  return { highlights: "hl", overview: "ov", ttm: "tt", consensus: "cs", support: "support" }[m[1]] ?? m[1];
}
function deepReplace(node, from, to) {
  let n = 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "number" && node[i] === from) { node[i] = to; n++; } else if (node[i] && typeof node[i] === "object") n += deepReplace(node[i], from, to);
    }
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (typeof node[k] === "number" && node[k] === from) { node[k] = to; n++; } else if (node[k] && typeof node[k] === "object") n += deepReplace(node[k], from, to);
    }
  }
  return n;
}

// ── 훅(검증기 프로세스 안, `node --import` 로 이 파일을 불러올 때) ────────────────────────────────────────────────
function installHook() {
  const orig = globalThis.fetch;
  const BASE = (process.env.MUT_BASE ?? "http://localhost:3000").replace(/\/$/, "");
  const CACHE = process.env.MUT_CACHE;
  const LOG = process.env.MUT_LOG;
  const mut = MUTATIONS.find((m) => m.id === process.env.MUT_ID) ?? null;
  if (process.env.MUT_ID && process.env.MUT_ID !== CONTROL && !mut) throw new Error(`알 수 없는 MUT_ID ${process.env.MUT_ID}`);
  if (CACHE) fs.mkdirSync(CACHE, { recursive: true });
  const log = (rec) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(rec) + "\n"); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let secChain = Promise.resolve(), secLast = 0;
  const secSlot = () => (secChain = secChain.then(async () => { const w = secLast + 500 - Date.now(); if (w > 0) await sleep(w); secLast = Date.now(); }));

  // 캐시 키 — Yahoo 는 요청마다 period2(현재 시각)·crumb 이 달라 빼고 잰다(기준선과 심기 실행이 같은 응답을 받게)
  const keyOf = (method, url, body) => {
    const u = new URL(url);
    for (const p of ["period2", "crumb"]) u.searchParams.delete(p);
    return createHash("sha1").update(`${method} ${u.href}\n${body ?? ""}`).digest("hex");
  };
  const fromCache = (k, url) => {
    const f = CACHE && path.join(CACHE, `${k}.json`);
    if (!f || !fs.existsSync(f)) return null;
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    const h = new Headers();
    for (const [n, v] of c.headers) h.append(n, v);
    const res = new Response(c.status === 204 || c.status === 304 ? null : Buffer.from(c.body, "base64"), { status: c.status, statusText: c.statusText ?? "", headers: h });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  const toCache = async (k, res) => {
    if (!CACHE) return res;
    const buf = Buffer.from(await res.arrayBuffer());
    const headers = [...res.headers].filter(([n]) => !["set-cookie", "content-encoding", "content-length", "transfer-encoding"].includes(n.toLowerCase()));
    for (const c of res.headers.getSetCookie?.() ?? []) headers.push(["set-cookie", c]);
    fs.writeFileSync(path.join(CACHE, `${k}.json`), JSON.stringify({ status: res.status, statusText: res.statusText, headers, body: buf.toString("base64") }));
    const out = new Response(res.status === 204 || res.status === 304 ? null : buf, { status: res.status, statusText: res.statusText, headers });
    Object.defineProperty(out, "url", { value: res.url });
    return out;
  };
  const live = async (input, init, url) => {
    const sec = /(^|\.)sec\.gov$/i.test(new URL(url).hostname);
    for (let attempt = 0; ; attempt++) {
      if (sec) await secSlot();
      const res = await orig(input, init);
      if (!(sec && res.status === 429 && attempt < 3)) return res;
      log({ t: "sec429", url });
      process.stderr.write(`[mut] SEC 429 — 65초 대기 후 재시도(${attempt + 1}/3): ${url}\n`);
      await sleep(65_000);
    }
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = String(init.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : null) ?? "GET").toUpperCase();
    const isApp = url.startsWith(BASE + "/");
    if (isApp && method !== "GET") throw new Error(`[mut] 앱에 ${method} 요청 차단(심은 오류 시험은 읽기 전용): ${url}`);
    const body = init.body == null ? "" : typeof init.body === "string" ? init.body : String(init.body);
    const k = keyOf(method, url, body);
    let res = fromCache(k, url);
    if (!res) {
      res = await live(input, init, url);
      if (res.ok || res.status === 404) res = await toCache(k, res);
    }
    if (!mut || !res.ok) return res;

    if (isApp) {
      const kind = kindOf(url);
      const plants = mut.plants.filter((p) => !p.kinds || p.kinds.includes(kind));
      if (!plants.length) return res;
      let j;
      try { j = await res.clone().json(); } catch { return res; }
      for (const p of plants) {
        const n = p.op === "replace" ? deepReplace(j, p.from, p.to) : p.fn(j, kind);
        if (n) log({ t: "plant", kind, what: p.op === "replace" ? `${p.from} → ${p.to}` : p.name, n });
      }
      return new Response(JSON.stringify(j), { status: res.status, headers: { "content-type": "application/json" } });
    }
    // 6b — Yahoo 일별 환율(TWDUSD=X 또는 TWD=X) FY 구간만 × k (역수 계열은 ÷ k)
    const fxm = mut.fx && /\/v8\/finance\/chart\/([A-Z]{3})(USD)?(?:%3D|=)X/i.exec(url);
    if (fxm && fxm[1].toUpperCase() === mut.fx.cur) {
      const inverse = !fxm[2];
      const j = await res.clone().json();
      const r0 = j?.chart?.result?.[0];
      let n = 0;
      for (let i = 0; i < (r0?.timestamp ?? []).length; i++) {
        const d = new Date(r0.timestamp[i] * 1000).toISOString().slice(0, 10);
        if (d < mut.fx.start || d > mut.fx.end) continue;
        for (const q of [...(r0.indicators?.quote ?? []), ...(r0.indicators?.adjclose ?? [])])
          for (const f of ["open", "high", "low", "close", "adjclose"]) if (q[f]?.[i] != null) q[f][i] = inverse ? q[f][i] / mut.fx.k : q[f][i] * mut.fx.k;
        n++;
      }
      log({ t: "plant", kind: "yahoo-fx", what: `${fxm[0]} ${mut.fx.start}~${mut.fx.end} ×${inverse ? "1/" : ""}${mut.fx.k}`, n });
      return new Response(JSON.stringify(j), { status: res.status, headers: { "content-type": "application/json" } });
    }
    return res;
  };
}

// ── 결과 대조 ─────────────────────────────────────────────────────────────────────────────────────────────────────
const metricOf = (name) => (/매출원가|매출총이익/.test(name) ? "cogs" : /매출|순수익|PSR/.test(name) ? "rev" : "other");
function indexRun(r) {
  const checks = new Map(), seen = new Map();
  for (const c of r?.checks ?? []) {
    const base = `${c.layer}|${c.name}|${c.col}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    checks.set(`${base}#${n}`, c);
  }
  const errs = new Map();
  for (const [kind, list] of [["rev", r?.revErrors], ["cogs", r?.cogsErrors]])
    for (const e of list ?? []) errs.set(`${kind}|${e.item}|${e.source}`, { ...e, kind });
  const cls = new Map();
  for (const x of r?.review ?? []) for (const [src, v] of Object.entries({ ...(x.revenueClass ?? {}), ...(x.metricClass ?? {}) })) cls.set(`${x.item}|${src}`, v);
  return { checks, errs, hard: new Set(r?.hardErrors ?? []), error: r?.error ?? null, cls };
}
function diffRuns(base, mut, m) {
  const B = indexRun(base), M = indexRun(mut);
  const fired = [], masked = [], noise = [];
  const counts = (x) => !m.countIf || m.countIf(x);
  for (const [k, c] of M.checks) {
    if (c.status !== "fail") continue;
    const b = B.checks.get(k);
    const x = { layer: c.layer, name: c.name, col: c.col, metric: metricOf(c.name), note: String(c.note ?? "").slice(0, 160) };
    if (b?.status === "fail") { if ((b.note ?? "") !== (c.note ?? "")) (counts(x) ? masked : noise).push(x); continue; }
    (counts(x) ? fired : noise).push(x);
  }
  for (const [k, e] of M.errs) {
    const b = B.errs.get(k);
    const x = { layer: "F", name: `③ 오류(${e.kind === "rev" ? "매출" : "매출원가·매출총이익"}) ${e.item} — ${e.source}`, col: "", metric: e.kind, note: `앱 ${e.ours} vs ${e.other}` };
    if (b) { if (b.ours !== e.ours) (counts(x) ? masked : noise).push(x); continue; }
    (counts(x) ? fired : noise).push(x);
  }
  for (const h of M.hard) if (!B.hard.has(h)) fired.push({ layer: "조회", name: `조회 실패 ${h.slice(0, 120)}`, col: "", metric: "other", note: "" });
  if (M.error && !B.error) fired.push({ layer: "오류", name: `종목 오류 ${M.error}`, col: "", metric: "other", note: "" });
  const clsChanged = [];
  for (const [k, v] of M.cls) if (B.cls.get(k) !== v) clsChanged.push(`${k}: ${B.cls.get(k) ?? "-"} → ${v}`);
  return { fired, masked, noise, clsChanged };
}

// ── 실행기 ────────────────────────────────────────────────────────────────────────────────────────────────────────
function runVerify({ sym, id, work, cache, base, external }) {
  const label = id === CONTROL ? `control-${sym}` : id || `baseline-${sym}`;
  const logFile = path.join(work, "runs", `${label}.plants.jsonl`);
  fs.rmSync(logFile, { force: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [
    "--import", pathToFileURL(SELF).href,
    path.join(ROOT, "scripts", "verify-financials.mjs"),
    `--symbols=${sym}`, "--metric=cogs", "--concurrency=1", `--base=${base}`, ...(external ? [] : ["--no-external"]),
  ], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60_000,
    env: { ...process.env, MUT_HOOK: "1", MUT_ID: id ?? "", MUT_CACHE: cache, MUT_BASE: base, MUT_LOG: logFile },
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  fs.writeFileSync(path.join(work, "runs", `${label}.log`), out);
  const plants = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const m = /결과 (\S.*?\.json)\s*$/m.exec(r.stdout ?? "");
  if (!m) return { label, secs, fail: `검증기 결과 파일 없음 (종료 ${r.status}${r.error ? ` · ${r.error.message}` : ""}) — ${out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`, plants };
  const src = m[1].replace(/^\/([A-Za-z]:)/, "$1");
  const dst = path.join(work, "runs", `${label}.verify.json`);
  fs.renameSync(src, dst);
  const j = JSON.parse(fs.readFileSync(dst, "utf8"));
  const res = j.results.find((x) => x.sym === sym) ?? null;
  return { label, secs, res, plants, sec429: plants.filter((p) => p.t === "sec429").length };
}

async function main() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !["only", "base", "no-external", "cache", "keep-cache", "list"].includes(m[1])) { console.error(`알 수 없는 인자: ${a}`); process.exit(2); }
    args[m[1]] = m[2] ?? true;
  }
  const only = args.only ? new Set(String(args.only).split(",").map((s) => s.trim())) : null;
  const list = MUTATIONS.filter((m) => !only || only.has(m.id));
  if (only) for (const id of only) if (!MUTATIONS.some((m) => m.id === id)) { console.error(`목록에 없는 id: ${id}`); process.exit(2); }
  if (args.list) {
    for (const m of list) console.log(`${m.id.padEnd(5)} [${m.cat} ${CATEGORIES[m.cat]}] ${m.sym} ${m.col} — ${m.what}${m.knownGap ? `  (알려진 공백: ${m.knownGap})` : ""}`);
    return 0;
  }
  const base = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
  const external = !args["no-external"];
  try {
    const r = await fetch(`${base}/api/markets/us/KO/support`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`앱 서버 응답 없음(${base}) — 개발 서버를 먼저 띄우세요: ${String(e).slice(0, 100)}`);
    return 2;
  }
  const kst = new Date(Date.now() + 9 * 3600e3).toISOString();
  const stamp = `${kst.slice(0, 10).replace(/-/g, "")}-${kst.slice(11, 19).replace(/:/g, "")}`;
  const work = path.join(ROOT, "reports", "mutation", stamp);
  fs.mkdirSync(path.join(work, "runs"), { recursive: true });
  const cache = args.cache ? path.resolve(String(args.cache)) : path.join(work, "cache");
  const syms = [...new Set(list.map((m) => m.sym))];
  console.log(`심은 오류 시험 — ${list.length}건 · 종목 ${syms.join(",")} · ${base} · 외부대조 ${external ? "켬" : "끔"} · 캐시 ${cache}`);

  const baselines = new Map();
  for (const sym of syms) {
    process.stdout.write(`기준선 ${sym} … `);
    const b = runVerify({ sym, id: "", work, cache, base, external });
    baselines.set(sym, b);
    const f = (b.res?.checks ?? []).filter((c) => c.status === "fail").length;
    console.log(b.fail ? `실패: ${b.fail}` : b.res?.error ? `종목 오류: ${b.res.error}` : `${b.secs}s · 검사 ${b.res.checks.length} · 기준선 FAIL ${f} · ③ ${(b.res.revErrors?.length ?? 0) + (b.res.cogsErrors?.length ?? 0)} · 조회 실패 ${b.res.hardErrors?.length ?? 0}${b.sec429 ? ` · SEC 429 ${b.sec429}회` : ""}`);
    if (b.fail || !b.res || b.res.error) continue;
    // 대조군 — 심기 없이 캐시로 한 번 더. 기준선과 달라지면(캐시 밖 요청·시각 의존) 이 종목의 검출 판정은 믿을 수 없다
    const c = runVerify({ sym, id: CONTROL, work, cache, base, external });
    const d = c.res ? diffRuns(b.res, c.res, {}) : null;
    if (!d || d.fired.length || d.masked.length) {
      b.fail = `대조군 불일치(재현성 없음): ${c.fail ?? [...d.fired, ...d.masked].slice(0, 3).map((x) => `${x.layer} ${x.name}[${x.col}]`).join("; ")}`;
      console.log(`  ${b.fail}`);
    }
  }

  const rows = [];
  for (const m of list) {
    process.stdout.write(`${m.id} ${m.sym} ${m.col} … `);
    const b = baselines.get(m.sym);
    const row = { id: m.id, cat: m.cat, catName: CATEGORIES[m.cat], sym: m.sym, col: m.col, what: m.what, origin: m.origin, expect: m.expect, knownGap: m.knownGap ?? null, countNote: m.countNote ?? null };
    if (b.fail || !b.res || b.res.error) { rows.push({ ...row, status: "기준선 오류", detected: null, by: [], note: b.fail ?? b.res?.error ?? "기준선 없음" }); console.log("기준선 오류"); continue; }
    const r = runVerify({ sym: m.sym, id: m.id, work, cache, base, external });
    const planted = r.plants.filter((p) => p.t === "plant");
    row.plants = planted;
    if (r.fail || !r.res) { rows.push({ ...row, status: "실행 오류", detected: null, by: [], note: r.fail }); console.log(`실행 오류: ${r.fail}`); continue; }
    const needFx = !!m.fx;
    const appPlanted = planted.some((p) => p.kind !== "yahoo-fx");
    const replaceOps = m.plants.filter((p) => p.op === "replace");
    const missOps = replaceOps.filter((p) => !planted.some((q) => q.what === `${p.from} → ${p.to}`));
    if (!appPlanted || missOps.length || (needFx && !planted.some((p) => p.kind === "yahoo-fx" && p.n > 0))) {
      rows.push({ ...row, status: "심기 실패", detected: null, by: [], note: `앱 값이 목록의 from 과 다름(앱이 바뀜 — 목록 갱신 필요): ${missOps.map((p) => p.from).join(", ") || (needFx ? "환율 응답 없음" : "대상 응답 없음")}` });
      console.log("심기 실패");
      continue;
    }
    const d = diffRuns(b.res, r.res, m);
    const detected = d.fired.length > 0;
    const expLayers = String(m.expect).split(/[,/]/);
    const byExpected = d.fired.some((x) => expLayers.includes(x.layer));
    const status = detected
      ? (m.knownGap ? "검출(알려진 공백 해소?)" : byExpected ? "검출" : "검출(기대 층 아님)")
      : d.masked.length ? (m.knownGap ? "미검출(알려진 공백) · 기존 실패에 가려짐" : "미검출(새 공백) · 기존 실패에 가려짐")
        : m.knownGap ? "미검출(알려진 공백)" : "미검출(새 공백)";
    rows.push({ ...row, status, detected, by: d.fired, masked: d.masked, noise: d.noise, clsChanged: d.clsChanged, secs: r.secs });
    console.log(`${status} (${r.secs}s)${d.fired.length ? ` — ${d.fired.slice(0, 2).map((x) => `${x.layer}:${x.name}[${x.col}]`).join(", ")}` : ""}`);
  }

  // ── 보고 ──
  const byTxt = (x) => {
    if (!x.by?.length) return x.masked?.length ? `(가려짐: ${x.masked.slice(0, 2).map((y) => `${y.layer} ${y.name}[${y.col}]`).join("; ")})` : "—";
    const layers = [...new Set(x.by.map((y) => y.layer))].join("·");
    return `${layers}: ${x.by.slice(0, 3).map((y) => `${y.name}${y.col ? `[${y.col}]` : ""}`).join("; ")}${x.by.length > 3 ? ` 외 ${x.by.length - 3}` : ""}`;
  };
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const md = [];
  md.push(`# 심은 오류 시험 결과 ${stamp} (KST)`, "", `기준 ${base} · 외부대조 ${external ? "켬" : "끔"} · 검증기 --metric=cogs(기본 검사 + 매출원가 검사 전부)`, "");
  md.push("| mutation | symbol / column | expected detection | detected? | by which check (layer/name) | status |", "|---|---|---|---|---|---|");
  for (const x of rows) md.push(`| ${x.id} ${esc(x.catName)} — ${esc(x.what)} | ${x.sym} / ${esc(x.col)} | ${x.knownGap ? `미검출 예상(알려진 공백) — 기대 층 ${x.expect}` : `${x.expect}층`} | ${x.detected == null ? "—" : x.detected ? "예" : "아니오"} | ${esc(byTxt(x))} | ${esc(x.status)} |`);
  const valid = rows.filter((x) => x.detected != null);
  const rate = (xs) => (xs.length ? `${xs.filter((x) => x.detected).length}/${xs.length} (${Math.round((100 * xs.filter((x) => x.detected).length) / xs.length)}%)` : "—");
  md.push("", `## 검출률`, "", `- 전체: ${rate(valid)}${rows.length !== valid.length ? ` — 판정 불가 ${rows.length - valid.length}건(심기 실패·실행 오류·기준선 오류) 제외` : ""}`);
  md.push(`- 알려진 공백 제외: ${rate(valid.filter((x) => !x.knownGap))}`);
  for (const c of Object.keys(CATEGORIES)) {
    const xs = valid.filter((x) => x.cat === Number(c));
    if (xs.length) md.push(`- ${c}. ${CATEGORIES[c]}: ${rate(xs)}`);
  }
  const und = valid.filter((x) => !x.detected);
  md.push("", "## 미검출 목록", "");
  if (!und.length) md.push("- 없음");
  for (const x of und) md.push(`- ${x.id} ${x.sym} ${x.col} ${x.what} — ${x.knownGap ? `**알려진 공백**: ${x.knownGap}` : "**새 공백**"}${x.masked?.length ? " (같은 검사가 기준선에서 이미 실패 중 — 가려짐)" : ""}${x.clsChanged?.length ? ` · 외부 분류 변화: ${x.clsChanged.slice(0, 3).join("; ")}` : ""}`);
  const bad = rows.filter((x) => x.detected == null);
  if (bad.length) { md.push("", "## 판정 불가", ""); for (const x of bad) md.push(`- ${x.id} ${x.status}: ${x.note}`); }
  const notes = rows.filter((x) => x.countNote || x.noise?.length);
  if (notes.length) {
    md.push("", "## 계측 메모", "");
    for (const x of notes) md.push(`- ${x.id}: ${x.countNote ?? ""}${x.noise?.length ? ` · 범위 밖 발화 ${x.noise.length}건(예: ${x.noise.slice(0, 2).map((y) => `${y.layer} ${y.name}[${y.col}]`).join("; ")})` : ""}`);
  }
  const text = md.join("\n");
  fs.writeFileSync(path.join(work, "result.md"), text + "\n");
  fs.writeFileSync(path.join(work, "result.json"), JSON.stringify({ at: new Date().toISOString(), base, external, cache, rows,
    baselines: Object.fromEntries([...baselines].map(([s, b]) => [s, { secs: b.secs, fail: b.fail ?? null, sec429: b.sec429 ?? 0 }])) }, null, 2));
  console.log(`\n${text}\n\n결과 ${path.join(work, "result.md")}`);
  if (!args.cache && !args["keep-cache"]) fs.rmSync(cache, { recursive: true, force: true });
  const newGap = und.filter((x) => !x.knownGap).length;
  return newGap || bad.length ? 1 : 0;
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (IS_MAIN) process.exitCode = await main();
else if (process.env.MUT_HOOK === "1") installHook();
