// 수집기 공통 종료 규칙(2026-10-06, 전수조사 구멍 #5·#6 — 수집기마다 0건·전송 실패 처리가 달랐다).
//
//   1) 앱 전송 실패 = 실패(exit 1): HTTP 2xx 가 아니거나, 응답 JSON 이 ok:false 이거나 error 를 담고 있으면.
//      그룹별로 나눠 보내는 수집기는 나머지 그룹을 계속 보내고 끝에 exit 1(process.exitCode) — appSendFailed().
//   2) 수집 0건 = 실패 아님(exit 0). 휴장일·주말이면 "정상" 로그, 거래일인데 0건이면 경고 로그만 — exitNoItems().
//      출처마다 원래 드문 곳이 있어 0건 자체로는 실패 처리하지 않는다. 파서가 깨져 며칠째 0건인 것은
//      1호기 healthcheck 의 출처별 신선도 감시(scripts/ops/research-freshness.mjs)가 잡는다.
//      (예전: 대신증권만 0건 exit 1 → 2026-10-05 대체공휴일 거짓 경보, 반대로 ds·globalmonitor·hankyung·mirae 는 전송 실패에도 exit 0)
//
// 휴장일 판정 = 앱과 같은 근거: src/lib/macro/kr/market-calendar.ts 의 KRX_HOLIDAYS 표를 글자 그대로 읽는다(TS 를 가져오지 않음 —
// server-only). 함수 이름도 앱과 같은 isKrxHolidaySync. 해외 출처는 그 나라 휴일까지는 보지 않고 주말만 본다.
import { readFileSync } from "node:fs";

/** 오늘 날짜(KST, YYYY-MM-DD) */
export function kstToday() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

let krxTable;
function krxHolidayTable() {
  if (krxTable !== undefined) return krxTable;
  try {
    const src = readFileSync(new URL("../../src/lib/macro/kr/market-calendar.ts", import.meta.url), "utf8");
    krxTable = new Map([...src.matchAll(/^\s*(\d{4}):\s*"([0-9\- ]+)"/gm)].map((m) => [Number(m[1]), m[2].trim().split(/\s+/)]));
  } catch {
    krxTable = null; // 파일을 못 읽으면 모름
  }
  return krxTable;
}

function isWeekend(date) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** 한국 증시 휴장일인가(YYYY-MM-DD) — 앱 market-calendar.ts 와 같은 판정. 주말·KRX 휴장일 true, 거래일 false, 표에 없는 해 null. */
export function isKrxHolidaySync(date) {
  if (isWeekend(date)) return true;
  const row = krxHolidayTable()?.get(Number(date.slice(0, 4)));
  if (row == null) return null;
  return row.includes(date.slice(5, 10));
}

/** 그 시장이 쉬는 날인가 — kr 은 KRX 휴장일, 그 외(us·글로벌 IB 등)는 주말만. 모르면 null. */
export function isMarketClosed(market = "kr", date = kstToday()) {
  return market === "kr" ? isKrxHolidaySync(date) : isWeekend(date);
}

/**
 * 수집 0건으로 끝낼 때 — 항상 exit 0(이미 전송 실패로 exitCode 가 1 이면 그대로).
 * @param {{ market?: string, label?: string, date?: string }} [opts] market: 출처의 시장(kr | us …), label: 로그 머리말
 */
export function exitNoItems({ market = "kr", label = "수집", date = kstToday() } = {}) {
  const closed = isMarketClosed(market, date);
  if (closed === true) {
    console.log(`· ${label} 0건 — ${date} 휴장일·주말(${market})이라 정상. 전송 생략.`);
  } else if (closed === false) {
    console.log(`::warning::${label} 0건 — ${date} 거래일인데 새 글 없음(드문 출처면 정상, 며칠째면 구조 변경 의심 — 신선도 감시가 판정). 전송 생략.`);
  } else {
    console.log(`::warning::${label} 0건 — ${date} 휴장일 여부 모름(달력 표에 없는 해). 전송 생략.`);
  }
  process.exit(process.exitCode ?? 0);
}

/**
 * 앱 전송 응답 판정 — 실패면 process.exitCode = 1 로 두고 true(오류 로그는 부르는 쪽이 출처·시장을 붙여 찍는다).
 * 실패 = HTTP 비 2xx, 또는 응답 JSON 의 ok === false, 또는 error 필드가 있음.
 * @param {Response} res fetch 응답
 * @param {string} text 이미 읽은 응답 본문
 */
export function appSendFailed(res, text) {
  let reason = null;
  if (!res.ok) reason = `HTTP ${res.status}`;
  else {
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        if (body.ok === false) reason = "응답 ok:false";
        else if (body.error != null && body.error !== "") reason = "응답 error";
      }
    } catch {
      // JSON 이 아닌 2xx 본문은 판정 근거가 없어 성공으로 본다
    }
  }
  if (!reason) return false;
  if (res.ok) console.error(`✗ 앱 응답이 실패를 알림(${reason})`); // 2xx 인데 실패 — 부르는 쪽 로그의 "HTTP 200" 만으로는 헷갈려서
  process.exitCode = 1;
  return true;
}
