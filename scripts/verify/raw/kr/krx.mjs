/**
 * 한국 시세 원천 받기(KRX OPEN API·KRX 휴장일 화면·공공데이터 배당) — 설계 10 §5.1, §3.6.
 *  - KRX 일별(stk/ksq_bydd_trd)·종목 기본정보(stk/ksq_isu_base_info): 판본 = 날짜. 지난 날짜(KST 오늘 전)이고 비어 있지 않은 응답만 저장.
 *    빈 응답은 저장하지 않고 그대로 돌려준다 — 휴장·게시 전·조회 실패 판정은 호출부(휴장일 달력)가 한다(오너 결정 2026-10-05).
 *    단 호출부가 휴장일로 확인한 날짜의 빈 응답은 holiday 판본으로 저장할 수 있다(putHolidayEmpty).
 *  - 하루 요청 상한(D18 — 운영과 같은 키): KRX_DAILY_CAP_VERIFY(기본 1,000).
 *  - KRX 휴장일 화면: 해마다 판본. 지난 해는 영구, 올해는 1일. 빈 목록(아직 공지 전)은 저장하지 않는다.
 *  - 공공데이터 배당(법인등록번호별 전 페이지): 내용 해시 판본, 1일(C10 — 지금은 캐시 없이 실행마다 전 페이지).
 */
import { checkJson } from "../common/format.mjs";
import { mutable } from "../common/fetchstore.mjs";
import { sha256 } from "../common/store.mjs";
import { FetchFailed, makeRequester, RETRY } from "../common/http.mjs";

const BASE = "https://data-dbg.krx.co.kr/svc/apis/sto";
const OTP = "https://open.krx.co.kr/contents/COM/GenerateOTP.jspx?bld=MKD/01/0110/01100305/mkd01100305_01&name=form";
const HOLI = "https://open.krx.co.kr/contents/OPN/99/OPN99000001.jspx";
const REF = "https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp";
const DATAGO = "https://apis.data.go.kr/1160100/GetStocDiviInfoService_V2/getDiviInfo_V2";
const H = 3600e3;
const kstToday = (now) => new Date(now().getTime() + 9 * H).toISOString().slice(0, 10).replace(/-/g, "");

export function makeKrx({ store, quotaRoot, key, datagoKey, tool = "verify", cap = Number(process.env.KRX_DAILY_CAP_VERIFY ?? 1000), fetchImpl, now = () => new Date() }) {
  const req = makeRequester({ source: "krx", quotaRoot, tool, dailyCap: cap, gapMs: 200, retry: RETRY.krx, fetchImpl, now });
  const reqOpen = makeRequester({ source: "krx-open", quotaRoot, tool, dailyCap: 200, gapMs: 1000, retry: RETRY.krx, fetchImpl, now });
  const reqGo = makeRequester({ source: "datago", quotaRoot, tool, dailyCap: Number(process.env.DATAGO_DAILY_CAP_VERIFY ?? 2000), gapMs: 300, retry: RETRY.datago, fetchImpl, now });
  const base = { store, market: "kr", source: "krx" };
  const outBlock = (b) => checkJson(b, (j) => (Array.isArray(j.OutBlock_1) ? null : "OutBlock_1 없음"));

  /**
   * 서비스 하루(svc = stk_bydd_trd·ksq_bydd_trd·stk_isu_base_info·ksq_isu_base_info)
   * @returns {Promise<{rows:any[], stored:boolean, fromStore:boolean}>}
   */
  async function day(svc, basDd) {
    if (!key) throw new Error("KRX_API_KEY 미설정");
    const q = { ...base, key: `${svc}_${basDd}`, ext: "json" };
    for (const v of [basDd, `${basDd}-holiday`]) {
      const hit = store.get({ ...q, version: v });
      if (hit) return { rows: JSON.parse(hit.buf).OutBlock_1, stored: true, fromStore: true, holiday: v.endsWith("holiday") };
    }
    const r = await req.get(`${BASE}/${svc}?basDd=${basDd}`, { headers: { AUTH_KEY: key }, timeoutMs: 30_000 });
    const v = outBlock(r.buf);
    if (!v.ok) throw new FetchFailed("krx", `KRX ${svc} ${basDd} 응답 형식 이상: ${v.why}`);
    const rows = JSON.parse(r.buf).OutBlock_1;
    if (rows.length && basDd < kstToday(now)) {
      store.put({ ...q, version: basDd, buf: r.buf, validate: outBlock });
      return { rows, stored: true, fromStore: false };
    }
    return { rows, stored: false, fromStore: false, buf: r.buf };
  }
  /** 호출부가 휴장일로 확인한 날짜의 빈 응답 저장 */
  function putHolidayEmpty(svc, basDd, buf) {
    if (JSON.parse(buf).OutBlock_1.length) throw new Error("휴장일 빈 응답 저장에 행이 있음");
    store.put({ ...base, key: `${svc}_${basDd}`, ext: "json", version: `${basDd}-holiday`, buf, validate: outBlock });
  }

  /** KRX 휴장일 화면 그 해(평일 휴장일 목록) */
  async function holidays(year) {
    const cy = Number(kstToday(now).slice(0, 4));
    const q = { ...base, source: "krx-open", key: `holiday_${year}`, ext: "json" };
    const okBlock = (b) => checkJson(b, (j) => (Array.isArray(j.block1) ? null : "block1 없음"));
    if (year < cy) {
      const hit = store.get({ ...q, version: String(year) });
      if (hit) return JSON.parse(hit.buf).block1;
    } else {
      const last = store.latest(q);
      if (last && now().getTime() - Date.parse(last.checkedAt) <= 24 * H) {
        const hit = store.get({ ...q, version: last.version });
        if (hit) return JSON.parse(hit.buf).block1;
      }
    }
    const hdr = { Referer: REF, "User-Agent": "Mozilla/5.0" };
    const code = (await reqOpen.get(`${OTP}&_=${Date.now()}`, { headers: hdr, timeoutMs: 20_000 })).buf.toString("utf8");
    if (!code || code.length > 2000 || /[<{\s]/.test(code)) throw new FetchFailed("krx-open", "KRX 휴장일 OTP 응답 이상");
    const body = new URLSearchParams({ search_bas_yy: String(year), gridTp: "KRX", pagePath: "/contents/MKD/01/0110/01100305/MKD01100305.jsp", code }).toString();
    const r = await reqOpen.get(HOLI, { method: "POST", headers: { ...hdr, "Content-Type": "application/x-www-form-urlencoded" }, body, timeoutMs: 20_000 });
    const v = okBlock(r.buf);
    if (!v.ok) throw new FetchFailed("krx-open", `KRX 휴장일 ${year} 응답 형식 이상: ${v.why}`);
    const block = JSON.parse(r.buf).block1;
    if (!block.length) return block; // 아직 공지 전 — 저장 안 함
    if (year < cy) store.put({ ...q, version: String(year), buf: r.buf, validate: okBlock });
    else {
      const version = `${year}-${kstToday(now)}`;
      const cur = store.latest(q);
      if (cur && store.get({ ...q, version: cur.version })?.sha256 === sha256(r.buf)) store.markChecked(q, cur.version);
      else store.put({ ...q, version, buf: r.buf, validate: okBlock, mutable: true });
    }
    return block;
  }

  /** 공공데이터 배당정보 한 쪽(법인등록번호·쪽 번호) — 1일 */
  async function datagoPage(crno, pageNo, numOfRows) {
    if (!datagoKey) throw new Error("DATA_GO_KR 키 미설정");
    const okResp = (b) => {
      const s = b.toString("utf8", 0, 400);
      if (s.includes("OpenAPI_ServiceResponse")) return { ok: false, why: `오류 응답 ${s.slice(0, 120)}` };
      return checkJson(b, (j) => (j?.response?.body ? null : "response.body 없음"));
    };
    const r = await mutable({
      store, req: reqGo, market: "kr", source: "datago", key: `divi_${crno}_n${numOfRows}_p${pageNo}`, ext: "json", ttlMs: 24 * H, now,
      url: `${DATAGO}?serviceKey=${datagoKey}&resultType=json&numOfRows=${numOfRows}&pageNo=${pageNo}&crno=${encodeURIComponent(crno)}`,
      validate: okResp,
      identity: (b) => {
        const it = JSON.parse(b)?.response?.body?.items?.item;
        const rows = it ? (Array.isArray(it) ? it : [it]) : [];
        return { ok: rows.every((x) => String(x.crno ?? crno) === String(crno)), got: rows[0]?.crno ?? null };
      },
    });
    return JSON.parse(r.buf.toString("utf8")).response.body;
  }

  return { req, reqOpen, reqGo, logs: [req.log, reqOpen.log, reqGo.log], day, putHolidayEmpty, holidays, datagoPage };
}
