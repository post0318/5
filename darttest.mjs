const KEY = "0b6d5869591517fe06ace7646ae3cf73ea240b6b";
const CORP = "00126380"; // 삼성전자
const j = async (u) => (await fetch(u)).json();

const co = await j(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${KEY}&corp_code=${CORP}`);
console.log("=company=", co.status, co.message);
console.log(JSON.stringify({corp_name:co.corp_name, corp_name_eng:co.corp_name_eng, ceo_nm:co.ceo_nm, corp_cls:co.corp_cls, adres:co.adres, hm_url:co.hm_url, ind_cd:co.ind_cd, est_dt:co.est_dt, acc_mt:co.acc_mt}));

const list = await j(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${KEY}&corp_code=${CORP}&bgn_de=20250101&end_de=20260101&page_count=5`);
console.log("=list=", list.status, list.message, "total", list.total_count);
for (const x of (list.list ?? []).slice(0,5)) console.log(" ", x.rcept_dt, x.report_nm, x.rcept_no);

const fs = await j(`https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${KEY}&corp_code=${CORP}&bsns_year=2024&reprt_code=11011&fs_div=CFS`);
console.log("=fnlttSinglAcntAll=", fs.status, fs.message, "rows", (fs.list||[]).length);
const seen = new Set();
for (const r of (fs.list ?? [])) {
  if (seen.has(r.sj_div)) continue; seen.add(r.sj_div);
  console.log(" sj", r.sj_div, r.sj_nm, "| ex account:", r.account_nm, "| thstrm", r.thstrm_nm, r.thstrm_amount, "| frmtrm", r.frmtrm_nm, r.frmtrm_amount);
}
const is = (fs.list||[]).filter(r=>r.sj_div==="IS"||r.sj_div==="CIS").slice(0,8);
console.log("IS/CIS sample:");
for (const r of is) console.log("  ", r.ord, r.account_nm, "=", r.thstrm_amount);
