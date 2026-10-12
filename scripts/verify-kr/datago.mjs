/**
 * 검증기 — 공공데이터포털 금융위원회 주식배당정보(GetStocDiviInfoService_V2/getDiviInfo_V2) 직접 조회(감사 2차 ⑦). 앱 rights-schedule.ts 와
 * 코드를 나누지 않는다 — 같은 공개 원천을 따로 부르는 것(KRX 와 같은 성격). 종목 필터는 법인등록번호(crno).
 * 반환: 보통주 배당 [{ bd: 배당기준일 YYYYMMDD, amt: 주당 배당금 }] — 기준일 오름차순(같은 기준일 행은 응답 순서 그대로). 조회 실패는 던진다.
 */
async function call(key, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  // 인증키는 Encoding 키(이미 URL 인코딩된 문자열) — 그대로 붙인다
  const url = `https://apis.data.go.kr/1160100/GetStocDiviInfoService_V2/getDiviInfo_V2?serviceKey=${key}&resultType=json&${qs}`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const t = await r.text();
      if (!r.ok || t.includes("OpenAPI_ServiceResponse")) throw new Error(`data.go.kr HTTP ${r.status}: ${t.slice(0, 120).replace(/\s+/g, " ")}`);
      const body = JSON.parse(t)?.response?.body;
      const it = body?.items?.item;
      return { rows: it ? (Array.isArray(it) ? it : [it]) : [], total: Number(body?.totalCount ?? 0) };
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
  }
}

export async function dataGoDividends(crno, key) {
  const head = await call(key, { numOfRows: "1", pageNo: "1", crno });
  if (!head.total) return [];
  const rows = [];
  // 전 페이지(오름차순) — 끝 페이지만 받으면 경계가 쪼개질 수 있어 전부
  for (let p = 1; p <= Math.ceil(head.total / 400); p++) rows.push(...(await call(key, { numOfRows: "400", pageNo: String(p), crno })).rows);
  const out = [];
  for (const r of rows) {
    if (!(r.scrsItmsKcd === "0101" || /보통/.test(r.scrsItmsKcdNm ?? ""))) continue;
    const amt = Number(String(r.stckGenrDvdnAmt ?? "").replace(/,/g, ""));
    const bd = String(r.dvdnBasDt ?? "").replace(/\D/g, "");
    if (bd.length !== 8 || !Number.isFinite(amt) || amt <= 0) continue;
    out.push({ bd, amt });
  }
  return out.sort((a, b) => a.bd.localeCompare(b.bd));
}
