/**
 * 미국 원천 받기(SEC) — 설계 10 §4.1, §3.6.
 *  - 순차 한 줄, 초당 3건 이하(334ms 간격). 429 면 65초 대기 후 최대 3회, 403 재시도 안 함.
 *  - User-Agent 에 실제 연락처 필수(D17): 없거나 example.com 자리표시자면 실행 거부.
 *  - 갱신형(company_tickers·companyfacts·submissions)은 12시간, 공시 원본(Archives)은 accn 판본으로 영구.
 *  - 읽을 때 신원 확인: companyfacts·submissions = cik, Archives index.json = 폴더 이름(cik/accn), XBRL 인스턴스·인라인 XBRL =
 *    dei:EntityCentralIndexKey, 링크베이스(_cal·_pre·_lab·_def) = 참조하는 .xsd 이름이 파일 이름 줄기와 같음.
 */
import { checkJson, checkNonEmpty, checkXml, checkZip } from "../common/format.mjs";
import { immutable, mutable } from "../common/fetchstore.mjs";
import { makeRequester, RETRY } from "../common/http.mjs";

const TTL_MS = Number(process.env.SEC_API_CACHE_TTL_H ?? 12) * 3600e3;
const ARCH = "https://www.sec.gov/Archives/edgar/data/";

export function secUserAgent(env = process.env) {
  const ua = env.SEC_USER_AGENT ?? "";
  if (!ua.trim() || /example\.com/i.test(ua) || !/@/.test(ua)) {
    throw new Error("SEC_USER_AGENT 에 실제 연락처가 없다(D17 — post0318@gmail.com). 자리표시자로는 실행하지 않는다");
  }
  return ua;
}

const pad10 = (cik) => String(cik).replace(/^0+/, "").padStart(10, "0");
const cikNum = (cik) => String(Number(cik));

export function makeSec({ store, quotaRoot, tool = "verify", fetchImpl, env = process.env, retry = RETRY.sec }) {
  const ua = secUserAgent(env);
  const req = makeRequester({ source: "sec", quotaRoot, tool, dailyCap: null, gapMs: 334, retry, fetchImpl });
  const headers = { "user-agent": ua };
  const base = { store, req, market: "us", source: "sec", headers };

  async function json(url, key, identity, require) {
    const r = await mutable({ ...base, key, ext: "json", url, ttlMs: TTL_MS, validate: (b) => checkJson(b, require), identity });
    return { json: JSON.parse(r.buf.toString("utf8")), version: r.version, sha256: r.sha256, fromStore: r.fromStore };
  }

  return {
    req,
    log: req.log,
    tickers: () => json("https://www.sec.gov/files/company_tickers.json", "company_tickers", (b) => {
      const j = JSON.parse(b);
      const first = j["0"];
      return { ok: !!first && "cik_str" in first && "ticker" in first, got: first ? Object.keys(first) : null };
    }),
    companyfacts: (cik) => json(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(cik)}.json`, `companyfacts_CIK${pad10(cik)}`, (b) => {
      const j = JSON.parse(b);
      return { ok: Number(j.cik) === Number(cik), got: j.cik };
    }, (j) => (j && j.cik != null && j.facts ? null : "companyfacts 필수 필드(cik·facts) 없음")),
    submissions: (cik) => json(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, `submissions_CIK${pad10(cik)}`, (b) => {
      const j = JSON.parse(b);
      return { ok: Number(j.cik) === Number(cik), got: j.cik };
    }, (j) => (j && j.cik != null && j.filings ? null : "submissions 필수 필드(cik·filings) 없음")),
    /** 과거 목록 파일(CIK##########-submissions-001.json) — 회사 식별 칸이 없어 형태만 확인 */
    submissionsPage: (name) => json(`https://data.sec.gov/submissions/${name}`, `submissions_${name}`, (b) => {
      const j = JSON.parse(b);
      return { ok: Array.isArray(j.accessionNumber), got: Object.keys(j).slice(0, 5) };
    }, (j) => (Array.isArray(j?.accessionNumber) ? null : "목록 파일 accessionNumber 없음")),
    /** 공시 폴더 안 파일(accn 판본, 영구) */
    archive: async (cik, accn, file, expect = null) => {
      const a18 = String(accn).replace(/-/g, "");
      if (!/^\d{18}$/.test(a18)) throw new Error(`accn 형식 오류: ${accn}`);
      const url = `${ARCH}${cikNum(cik)}/${a18}/${file}`;
      const ext = (file.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "bin").toLowerCase();
      const r = await immutable({
        ...base, key: `${cikNum(cik)}/${a18}/${file}`, version: a18, ext, url,
        validate: validatorFor(ext), identity: identityFor({ cik, a18, file, ext, expect }), equivalent: equivalentFor(ext),
      });
      return { buf: r.buf, sha256: r.sha256, fromStore: r.fromStore, url };
    },
  };
}

/**
 * SEC 가 HTML 응답 끝에 봇 차단 스크립트(<script type="text/javascript"  src="/임의 경로">)를 붙여 같은 공시 HTML 의 바이트가
 * 받을 때마다 다르다(실측 2026-10-15: TSM 6-K tsm-revenue20261008.htm 앱 사본과 검증기 사본이 이 한 줄만 다름). 이 줄을 뺀 내용이 같으면 같은 원본.
 */
const INJECTED_SCRIPT_RE = /<script type="text\/javascript"\s+src="\/[A-Za-z0-9/_-]+"><\/script>/g;
export function equivalentFor(ext) {
  if (ext !== "htm" && ext !== "html") return undefined;
  return (a, b) => a.toString("latin1").replace(INJECTED_SCRIPT_RE, "") === b.toString("latin1").replace(INJECTED_SCRIPT_RE, "");
}

function validatorFor(ext) {
  if (ext === "json") return (b) => checkJson(b);
  if (ext === "xml" || ext === "xsd") return checkXml;
  if (ext === "zip") return checkZip;
  return checkNonEmpty;
}

const CIK_RE = /<dei:EntityCentralIndexKey[^>]*>\s*0*(\d+)\s*</;
/** 파일 안 신원이 요청과 맞는지 — 맞출 표지가 없는 파일(일반 HTML 첨부)은 형태만 */
const DOCTYPE_RE = /<dei:DocumentType[^>]*>\s*([^<\s]+)\s*</;
const PEREND_RE = /<dei:DocumentPeriodEndDate[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*</;
/** expect = { form, periodEnd } — 인스턴스면 서류 종류(dei:DocumentType)·기간 끝(dei:DocumentPeriodEndDate)도 맞아야(감사 10-16 ③-5: 회사만 확인해
 *  같은 회사 10-Q 인스턴스가 10-K 열쇠로 들어가도 통과했다). 정정(/A)은 원 종류로, 기간 끝은 ±7일(52/53주 결산 표기 차) */
export function identityFor({ cik, a18, file, ext, expect = null }) {
  return (buf) => {
    if (ext === "json" && /index\.json$/.test(file)) {
      const j = JSON.parse(buf);
      const name = String(j?.directory?.name ?? "");
      return { ok: name.endsWith(`/${Number(cik)}/${a18}`), got: name };
    }
    if (ext === "xml" || ext === "htm" || ext === "html") {
      const s = buf.toString("utf8", 0, Math.min(buf.length, 4_000_000));
      const m = s.match(CIK_RE);
      if (m) {
        if (Number(m[1]) !== Number(cik)) return { ok: false, got: m[1] };
        if (expect) {
          const dt = s.match(DOCTYPE_RE)?.[1] ?? null, pe = s.match(PEREND_RE)?.[1] ?? null;
          const base = (f) => String(f ?? "").replace(/\/A$/, "");
          if (expect.form && dt && base(dt) !== base(expect.form)) return { ok: false, got: { cik: m[1], documentType: dt, expected: expect.form } };
          if (expect.periodEnd && pe && Math.abs(Date.parse(pe) - Date.parse(expect.periodEnd)) > 7 * 864e5) return { ok: false, got: { cik: m[1], periodEnd: pe, expected: expect.periodEnd } };
          return { ok: true, got: { cik: m[1], documentType: dt, periodEnd: pe } };
        }
        return { ok: true, got: m[1] };
      }
      const lb = file.match(/^(.*)_(cal|pre|lab|def)\.xml$/);
      if (lb) {
        // 회사 스키마 참조(http 로 시작하지 않는 .xsd) — 표준 역할 스키마(xbrl.org) 참조는 건너뛴다
        const local = [...new Set([...s.matchAll(/xlink:href="([^"#]+)\.xsd#/g)].map((m) => m[1]).filter((h) => !/^https?:/.test(h)))];
        return { ok: local.includes(lb[1]), got: local.slice(0, 3) };
      }
      return { ok: true, got: "no-identity-marker" };
    }
    if (ext === "xsd") {
      const stem = file.replace(/\.xsd$/, "");
      const s = buf.toString("utf8", 0, Math.min(buf.length, 400_000));
      // 회사 확장 스키마는 자기 링크베이스(stem_cal.xml 등)를 참조한다
      return { ok: s.includes(`${stem}_`) || s.includes(`${stem}.xsd`) || !/linkbaseRef/.test(s), got: stem };
    }
    return { ok: true, got: "no-identity-marker" };
  };
}
