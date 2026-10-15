/**
 * 한국 원천 받기(OpenDART) — 설계 10 §5.1, §3.6.
 *  - 순차 한 줄, 간격 300ms, 재시도 2회(2·4초). 하루 상한(DART_DAILY_CAP_VERIFY, 기본 3,000), 020 이면 전체 중단, 800 이면 점검(30분 XBRL 생략).
 *  - 보고서 응답(fnlttSinglAcntAll·alotMatter·stockTotqySttus) 판본 = 그 보고서의 최신 접수번호(목록에 없으면 "none").
 *    정정 공시가 나오면 새 판본을 추가하고 옛 판본은 보관 — 다시 받을 수 없으므로 복구 불가(irrecoverable) 표시(D15).
 *  - 접수번호로 받는 원본(fnlttXbrl·document) 판본 = 접수번호(불변). 목록(list.json)은 6시간, corpCode 1일, company 30일.
 *  - 저장하는 상태는 000·013 만. 그 밖의 상태·빈 응답·깨진 JSON·zip 은 저장하지 않는다.
 *  - 읽을 때 신원: 보고서 응답 = 행의 corp_code·rcept_no(000 일 때), XBRL zip = 항목 이름의 entity{corp_code}, 원문 zip = 항목 이름의 접수번호,
 *    company = corp_code.
 */
import { checkJson, checkZip, unzipEntries } from "../common/format.mjs";
import { immutable, mutable } from "../common/fetchstore.mjs";
import { FetchFailed, makeRequester, RETRY, SourceMaintenance } from "../common/http.mjs";

const B = "https://opendart.fss.or.kr/api";
const H = 3600e3;

/** 응답 상태 판독(zip 이 아니면) — 000·013 외는 던진다 */
function statusOf(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
  const s = buf.toString("utf8", 0, Math.min(buf.length, 600));
  return s.match(/"status"\s*:\s*"(\d{3})"/)?.[1] ?? s.match(/<status>(\d{3})<\/status>/)?.[1] ?? null;
}

export function makeDart({ store, quotaRoot, key, tool = "verify", cap = Number(process.env.DART_DAILY_CAP_VERIFY ?? 3000), fetchImpl, now = () => new Date() }) {
  if (!key) throw new Error("DART_API_KEY 미설정");
  const req = makeRequester({ source: "dart", quotaRoot, tool, dailyCap: cap, gapMs: 300, retry: RETRY.dart, fetchImpl, now });
  let maintUntil = 0;
  const base = { store, req, market: "kr", source: "dart" };
  const url = (path, params) => `${B}/${path}?${new URLSearchParams({ crtfc_key: key, ...params })}`;

  /** 저장 전 상태 검사 — 020 전체 중단, 800 점검, 000·013·zip 만 통과 */
  function inspect(kind, allowZip) {
    return (buf) => {
      const st = statusOf(buf);
      if (st === "020") req.stop("020", "DART 응답 020(사용한도 초과) — 그 자리에서 전체 중단");
      if (st === "800") {
        maintUntil = Date.now() + 30 * 60e3;
        throw new SourceMaintenance("dart", `DART ${kind} 800(점검)`);
      }
      if (st === "zip" && allowZip) return;
      if (st === "000" || st === "013") return;
      throw new FetchFailed("dart", `DART ${kind} 상태 ${st ?? "알 수 없음"}: ${buf.toString("utf8", 0, 160)}`, { status: st });
    };
  }
  const jsonOk = (b) => checkJson(b, (j) => (j.status === "000" || j.status === "013" ? null : `status ${j.status}`));

  /** 보고서 응답 하나(판본 = 최신 접수번호 또는 none) */
  async function report(path, kind, keyParts, apiParams, rcept, corp) {
    const k = `${kind}_${keyParts.join("_")}`;
    const r = await immutable({
      ...base, key: k, version: rcept ?? "none", ext: "json", url: url(path, apiParams), irrecoverable: true,
      validate: jsonOk, inspect: inspect(kind, false),
      identity: (b) => {
        const j = JSON.parse(b);
        if (j.status === "013") return { ok: true, got: "013" };
        const row = j.list?.[0];
        const okCorp = row?.corp_code === corp;
        // 판본 = 목록의 최신 접수번호. 재무 숫자를 다시 싣지 않은 정정([첨부정정] 등)이면 행의 접수번호는 원 보고서(더 이른 번호)일 수 있다 — 판본 이하만 허용
        const okRcept = rcept == null || row?.rcept_no == null || row.rcept_no <= rcept;
        return { ok: okCorp && okRcept, got: { corp: row?.corp_code, rcept: row?.rcept_no } };
      },
    });
    return { json: JSON.parse(r.buf.toString("utf8")), sha256: r.sha256, fromStore: r.fromStore, version: rcept ?? "none" };
  }

  return {
    req,
    log: req.log,
    /** 정기공시 목록 한 쪽(6시간) */
    listPage: async (corp, bgn, page, ty = "A") => {
      const end = new Date(now().getTime() + 9 * H).toISOString().slice(0, 10).replace(/-/g, "");
      const r = await mutable({
        ...base, key: `list_${corp}_${ty}_${bgn}_p${page}`, ext: "json", ttlMs: 6 * H, now,
        url: url("list.json", { corp_code: corp, bgn_de: `${bgn}0101`, end_de: end, pblntf_ty: ty, page_count: "100", page_no: String(page) }),
        validate: jsonOk, inspect: inspect("list.json", false),
        identity: (b) => {
          const j = JSON.parse(b);
          if (j.status === "013") return { ok: true, got: "013" };
          return { ok: (j.list ?? []).every((x) => x.corp_code === corp), got: j.list?.[0]?.corp_code };
        },
      });
      return { json: JSON.parse(r.buf.toString("utf8")), version: r.version, checkedAt: r.checkedAt };
    },
    fnltt: (corp, year, code, fs, rcept) => report("fnlttSinglAcntAll.json", "fnltt", [corp, year, code, fs],
      { corp_code: corp, bsns_year: String(year), reprt_code: code, fs_div: fs }, rcept, corp),
    alot: (corp, year, code, rcept) => report("alotMatter.json", "alot", [corp, year, code],
      { corp_code: corp, bsns_year: String(year), reprt_code: code }, rcept, corp),
    stockTotqy: (corp, year, code, rcept) => report("stockTotqySttus.json", "stock", [corp, year, code],
      { corp_code: corp, bsns_year: String(year), reprt_code: code }, rcept, corp),
    /** 증자(감자) 현황 — 분할·병합·무상증자 사건(R-KR9) */
    irds: (corp, year, code, rcept) => report("irdsSttus.json", "irds", [corp, year, code],
      { corp_code: corp, bsns_year: String(year), reprt_code: code }, rcept, corp),
    /** XBRL 원본 zip(접수번호, 불변) */
    xbrl: async (rcept, reprtCode, corp) => {
      if (Date.now() < maintUntil) throw new SourceMaintenance("dart", "DART XBRL 점검(800) 30분 안 — 요청 생략");
      const r = await immutable({
        ...base, key: `xbrl_${rcept}`, version: rcept, ext: "zip", url: url("fnlttXbrl.xml", { rcept_no: rcept, reprt_code: reprtCode }),
        validate: checkZip, inspect: inspect("fnlttXbrl", true),
        identity: (b) => {
          const names = unzipEntries(b).map((e) => e.name);
          // 항목 이름 = entity{corp}_… 또는 옛 형식 {corp}_…
          const corps = new Set(names.map((n) => n.match(/^(?:entity)?(\d{8})_/)?.[1]).filter(Boolean));
          return { ok: corps.size === 1 && corps.has(corp), got: [...corps] };
        },
      });
      return { buf: r.buf, sha256: r.sha256, fromStore: r.fromStore };
    },
    /** 원문 zip(접수번호, 불변) */
    document: async (rcept) => {
      const r = await immutable({
        ...base, key: `doc_${rcept}`, version: rcept, ext: "zip", url: url("document.xml", { rcept_no: rcept }),
        validate: checkZip, inspect: inspect("document", true),
        identity: (b) => {
          const names = unzipEntries(b).map((e) => e.name);
          return { ok: names.length > 0 && names.every((n) => n.startsWith(rcept)), got: names.slice(0, 3) };
        },
      });
      return { buf: r.buf, sha256: r.sha256, fromStore: r.fromStore };
    },
    corpCodes: async () => {
      const r = await mutable({
        ...base, key: "corpCode", ext: "zip", ttlMs: 24 * H, now, url: url("corpCode.xml", {}),
        validate: checkZip, inspect: inspect("corpCode", true),
        identity: (b) => {
          const names = unzipEntries(b).map((e) => e.name);
          return { ok: names.includes("CORPCODE.xml"), got: names };
        },
      });
      return { buf: r.buf, version: r.version };
    },
    company: async (corp) => {
      const r = await mutable({
        ...base, key: `company_${corp}`, ext: "json", ttlMs: 30 * 24 * H, now, url: url("company.json", { corp_code: corp }),
        validate: jsonOk, inspect: inspect("company", false),
        identity: (b) => { const j = JSON.parse(b); return { ok: j.corp_code === corp, got: j.corp_code }; },
      });
      return { json: JSON.parse(r.buf.toString("utf8")), version: r.version };
    },
  };
}
