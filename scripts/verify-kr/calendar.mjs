/**
 * 검증기 — 한국 증시 휴장일 달력(오너 결정 2026-10-05 "거래일의 KRX 빈 응답 = 조회 실패"). 앱 표(src/lib/macro/kr/market-calendar.ts
 * KRX_HOLIDAYS)를 가져다 쓰지 않고 **KRX 휴장일 조회 화면(open.krx.co.kr MKD01100305)을 따로 받아** 판정한다. 받은 목록이 앱 표와 한 날이라도
 * 다르면 던진다(둘이 같아야 한다 — 앱 표가 틀리면 앱의 휴장 판정도 틀린다). 표에 그 해가 없고 KRX 도 목록이 없으면 null(모름).
 * 지난 해는 디스크 캐시(불변), 올해는 날짜별로 다시 받는다.
 */
import { readFileSync } from "node:fs";

const OTP = "https://open.krx.co.kr/contents/COM/GenerateOTP.jspx?bld=MKD/01/0110/01100305/mkd01100305_01&name=form";
const DATA = "https://open.krx.co.kr/contents/OPN/99/OPN99000001.jspx";
const REF = "https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp";
let CACHE = null;
export function configureCalendar({ cache }) {
  CACHE = cache;
}
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

/** 앱 표(문자열 그대로 읽기 — TS 를 가져오지 않음) */
let appTable = null;
function appHolidays() {
  if (!appTable) {
    const src = readFileSync(new URL("../../src/lib/macro/kr/market-calendar.ts", import.meta.url), "utf8");
    appTable = new Map([...src.matchAll(/^\s*(\d{4}):\s*"([0-9\- ]+)"/gm)].map((m) => [Number(m[1]), m[2].trim().split(/\s+/).sort().join(" ")]));
  }
  return appTable;
}

async function fetchKrxHolidays(year) {
  const H = { Referer: REF, "User-Agent": "Mozilla/5.0" };
  for (let i = 0; ; i++) {
    try {
      const code = await (await fetch(`${OTP}&_=${Date.now()}`, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
      if (!code || code.length > 2000 || /[<{\s]/.test(code)) throw new Error("KRX 휴장일 OTP 응답 이상");
      const body = new URLSearchParams({ search_bas_yy: String(year), gridTp: "KRX", pagePath: "/contents/MKD/01/0110/01100305/MKD01100305.jsp", code });
      const r = await fetch(DATA, { method: "POST", headers: { ...H, "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`KRX 휴장일 ${year} HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j.block1)) throw new Error(`KRX 휴장일 ${year} 응답 형식 이상`);
      return j.block1.map((x) => String(x.calnd_dd).slice(5, 10)).filter((d) => /^\d{2}-\d{2}$/.test(d)).sort();
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise((res) => setTimeout(res, [1000, 3000, 9000][i]));
    }
  }
}

const memo = new Map();
/** 그 해 평일 휴장일(MM-DD Set) — KRX 목록, 앱 표와 다르면 던짐. 둘 다 없으면 null */
export function krxHolidays(year) {
  if (!memo.has(year)) memo.set(year, (async () => {
    const cy = Number(kstToday().slice(0, 4));
    const ver = year < cy ? "v1" : kstToday();
    let days = CACHE ? CACHE.get("krx-holiday", String(year), ver) : undefined;
    if (days === undefined) {
      days = await fetchKrxHolidays(year);
      // KRX 가 아직 공지하지 않은 해는 빈 목록 — 캐시하지 않음
      if (CACHE && days.length) CACHE.put("krx-holiday", String(year), ver, days);
    }
    const app = appHolidays().get(year) ?? null;
    if (!days.length && app == null) return null;
    const mine = days.join(" ");
    if (app !== mine) throw new Error(`휴장일 달력 불일치 ${year}: 앱 표(market-calendar.ts) "${app ?? "없음"}" ≠ KRX 휴장일 조회 "${mine || "없음"}"`);
    return new Set(days);
  })());
  return memo.get(year);
}

/**
 * 날짜(YYYYMMDD)의 빈 응답 뜻 — holiday(주말·휴장일) | pending(그 거래일부터 다음 거래일까지 KST — 게시 전일 수 있음) | expected(다음 거래일도
 * 지난 거래일 — 빈 응답이면 KRX 조회 실패) | unknown(달력 모름 — 실패로 본다). 앱 krx.ts krxEmptyKind 와 같은 규칙(규칙 문장만 보고 따로 짬)
 */
export async function emptyKind(basDd) {
  const date = `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return "holiday";
  const today = kstToday();
  const hs = await krxHolidays(Number(basDd.slice(0, 4)));
  if (hs?.has(date.slice(5))) return "holiday";
  if (date >= today) return "pending";
  if (!hs) return "unknown";
  // 다음 거래일(그날까지는 게시 전일 수 있음) — 그 뒤면 자료가 있어야 한다
  const d = new Date(`${date}T00:00:00Z`);
  for (let i = 0; i < 20; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const s = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const h2 = await krxHolidays(Number(s.slice(0, 4)));
    if (!h2) return "unknown";
    if (!h2.has(s.slice(5))) return s >= today ? "pending" : "expected";
  }
  return "unknown";
}
