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

export function makeEdinet({ store, quotaRoot, key, tool = "verify", cap = Number(process.env.EDINET_DAILY_CAP_VERIFY ?? 3000), fetchImpl, now = () => new Date() }) {
  if (!key) throw new Error("EDINET_API_KEY 미설정");
  const req = makeRequester({ source: "edinet", quotaRoot, tool, dailyCap: cap, gapMs: Number(process.env.JP_VERIFY_EDINET_GAP_MS ?? 1000), retry: RETRY.edinet, fetchImpl, now });
  const base = { store, req, market: "jp", source: "edinet" };

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
    const identity = (b) => {
      const rows = JSON.parse(b).results;
      return { ok: rows.every((r) => !r.submitDateTime || String(r.submitDateTime).startsWith(date)), got: rows[0]?.submitDateTime ?? null };
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
  async function docZip(docID, edinetCode) {
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
        } catch (e) {
          why = `zip·JSON 아님(${String(e.message).slice(0, 40)})`;
        }
        throw new FetchFailed("edinet", `EDINET 서류 ${docID} — ${why}`);
      },
      identity: (b) => {
        const names = unzipEntries(b).map((e) => e.name).filter((n) => /PublicDoc\//.test(n));
        if (!edinetCode) return { ok: names.length > 0, got: names.length };
        return { ok: names.length > 0 && names.some((n) => n.includes(`_${edinetCode}-`)), got: names[0] ?? null };
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
