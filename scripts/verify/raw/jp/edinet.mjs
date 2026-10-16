/**
 * 일본 원천 받기(EDINET API v2) — 설계 10 §6.1, §3.6.
 *  - 순차 한 줄, 시작 간격 1초(JP_VERIFY_EDINET_GAP_MS), 429·5xx 재시도 2회(3·6초). 하루 상한(D18 — 앱과 같은 키): EDINET_DAILY_CAP_VERIFY(기본 3,000).
 *  - 날짜별 서류 목록(type=2): 확정일(JST 오늘 − 2일 이전)은 날짜 판본으로 영구, 최근 2일은 저장하지 않고 실행마다 받는다.
 *    status ≠ 200·건수 불일치·JSON 아님 → FetchFailed(저장 안 함).
 *  - 서류 zip(type=1): docID 판본(불변). zip 이 아니면(HTTP 200 에 JSON 오류) FetchFailed.
 *  - EDINET 코드 목록(Edinetcode.zip): 내용 해시, 1일.
 *  - 읽을 때 신원: 목록 = 행 날짜(submitDateTime)가 그 날짜, 서류 zip = 항목 이름의 EDINET 코드(호출부가 아는 경우).
 */
import { checkJson, checkZip, unzipEntries } from "../common/format.mjs";
import { immutable, mutable } from "../common/fetchstore.mjs";
import { FetchFailed, makeRequester, RETRY } from "../common/http.mjs";

const BASE = "https://api.edinet-fsa.go.jp/api/v2";
const CODELIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
const H = 3600e3;
const jstDate = (now, minusDays = 0) => new Date(now().getTime() + 9 * H - minusDays * 864e5).toISOString().slice(0, 10);

export function makeEdinet({ store, quotaRoot, key, tool = "verify", cap = Number(process.env.EDINET_DAILY_CAP_VERIFY ?? 3000), fetchImpl, now = () => new Date(), replay = false }) {
  if (!key) throw new Error("EDINET_API_KEY 미설정");
  const req = makeRequester({ source: "edinet", quotaRoot, tool, dailyCap: cap, gapMs: Number(process.env.JP_VERIFY_EDINET_GAP_MS ?? 1000), retry: RETRY.edinet, fetchImpl, now });
  const base = { store, req, market: "jp", source: "edinet", replay };

  const listOk = (b) => checkJson(b, (j) => {
    if (String(j?.metadata?.status) !== "200") return `status ${j?.metadata?.status} ${j?.metadata?.message ?? ""}`;
    if (!Array.isArray(j.results)) return "results 없음";
    const cnt = j.metadata?.resultset?.count;
    if (cnt != null && Number(cnt) !== j.results.length) return `건수 불일치 ${j.results.length} ≠ ${cnt}`;
    return null;
  });

  /** 날짜 하루 목록 */
  async function dayList(date) {
    const url = `${BASE}/documents.json?date=${date}&type=2&Subscription-Key=${key}`;
    // 목록 날짜 = 응답 metadata.parameter.date(ファイル日付 — 제출일이 아닌 정정·취하 날짜의 서류도 실린다)
    const identity = (b) => {
      const p = JSON.parse(b).metadata?.parameter ?? {};
      return { ok: p.date === date && String(p.type) === "2", got: p };
    };
    if (date <= jstDate(now, 2)) {
      const r = await immutable({ ...base, key: `list_${date}`, version: date, ext: "json", url, validate: listOk, identity });
      return { json: JSON.parse(r.buf.toString("utf8")), fromStore: r.fromStore, final: true };
    }
    const r = await req.get(url, { timeoutMs: 90_000 });
    const v = listOk(r.buf);
    if (!v.ok) throw new FetchFailed("edinet", `EDINET 목록 ${date}: ${v.why}`);
    return { json: JSON.parse(r.buf.toString("utf8")), fromStore: false, final: false };
  }

  /** 서류 XBRL zip(type=1) */
  /** expect = { form(docTypeCode), periodEnd } — 서류 종류(파일명 asr·ssr·q?r)·기간 끝(파일명 날짜)도 확인(감사 10-16 ③-5, 회사만 보던 것) */
  const KIND = { 120: /-asr-/, 130: /-asr-/, 140: /-q\dr-/, 150: /-q\dr-/, 160: /-(ssr|q2r)-/, 170: /-(ssr|q2r)-/ }; // 半期 = ssr 또는 q2r(2024 개편 뒤 jpcrp040300-q2r, 실측)
  async function docZip(docID, edinetCode, expect = null) {
    if (!/^S1[0-9A-Z]{6}$/.test(docID)) throw new Error(`docID 형식 오류: ${docID}`);
    const r = await immutable({
      ...base, key: `doc_${docID}`, version: docID, ext: "zip", url: `${BASE}/documents/${docID}?type=1&Subscription-Key=${key}`,
      validate: checkZip,
      inspect: (buf) => {
        if (buf[0] === 0x50 && buf[1] === 0x4b) return;
        let why = "zip 아님";
        try {
          const m = JSON.parse(buf.toString("utf8")).metadata;
          why = `상태 ${m?.status} ${m?.message ?? ""}`;
        } catch (e) { // silent-ok: 사유를 why 에 담아 바로 아래에서 FetchFailed 로 던짐
          why = `zip·JSON 아님(${String(e.message).slice(0, 40)})`;
        }
        throw new FetchFailed("edinet", `EDINET 서류 ${docID} — ${why}`);
      },
      identity: (b) => {
        const names = unzipEntries(b).map((e) => e.name).filter((n) => /PublicDoc\//.test(n));
        if (!edinetCode) return { ok: names.length > 0, got: names.length };
        const x = names.filter((n) => /\.xbrl$/.test(n) && n.includes(`_${edinetCode}-`));
        if (!x.length) return { ok: false, got: names[0] ?? null };
        if (expect?.form && KIND[expect.form] && !x.some((n) => KIND[expect.form].test(n))) return { ok: false, got: { file: x[0], expectedForm: expect.form } };
        // 기간 끝은 연간(120·130)만 — 半期 목록의 periodEnd 는 사업연도 끝이라 파일명(반기 끝)과 다르다(실측 117건)
        if (expect?.periodEnd && ["120", "130"].includes(String(expect.form)) && !x.some((n) => n.includes(`_${expect.periodEnd}_`))) return { ok: false, got: { file: x[0], expectedPeriodEnd: expect.periodEnd } };
        return { ok: true, got: x[0] };
      },
    });
    return { buf: r.buf, sha256: r.sha256, fromStore: r.fromStore };
  }

  async function codeList() {
    const r = await mutable({
      ...base, key: "edinetcode", ext: "zip", ttlMs: 24 * H, now, url: CODELIST, validate: checkZip,
      identity: (b) => {
        const names = unzipEntries(b).map((e) => e.name);
        return { ok: names.some((n) => /EdinetcodeDlInfo\.csv$/i.test(n)), got: names };
      },
    });
    return { buf: r.buf, version: r.version };
  }

  return { req, log: req.log, dayList, docZip, codeList };
}
