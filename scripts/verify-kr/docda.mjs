/**
 * 검증기 — 원문 감가상각 표 판독(감사 2차 2026-10-05). 감가상각 적재본(kr_da) 중 XBRL 로 재현되지 않는 칸(원문 현금흐름 조정 주석 해, 영업비용 기준
 * 성격별 비용 표 해, 사용권자산 줄 원문 보완 해, TTM 누적)을 **검증기가 원문 표를 따로 읽어** 대조한다. 앱 적재 스크립트(populate-kr-da.mjs)의 판독
 * 코드(parseDocDa·parseNatureDa 등)를 가져오지 않는다 — 규칙 문장(감가상각 = 유형 + 사용권자산 + 투자부동산 감가상각 + 무형자산상각, 또는 합친 줄)만
 * 보고 다시 짠 판독.
 *
 * 판독: 감가상각 줄이 있는 표를 줄 이름으로 나눈다(같은 표에 당기·전기 묶음이 이어 실리면 감가상각 줄이 다시 나올 때 새 묶음). 묶음마다 숫자 열
 * 위치별로 후보 합을 만든다 — 합친 줄(감가상각비 및 무형자산상각비), 감가 + 무형, 감가 + 사용권 + 무형, 감가 + 투자부동산 + 무형, 감가 + 사용권 +
 * 투자부동산 + 무형. 값 × 표 단위. 적재 값이 후보 중 하나와 **정확히** 같으면 원문 근거가 있는 값이다(12자리 수가 우연히 같을 일은 없다고 본다).
 * 열 위치(당기·전기·누적)를 판독하지 않는 대신 이웃 해 값과 같은 후보는 실패 사유에 따로 적는다.
 */
const lab = (s) => String(s ?? "").replace(/^[\s\-–·ㆍ•\d.)]+/, "").replace(/\(주\s*\d+[^)]*\)/g, "").replace(/\s/g, "");
const num = (c) => {
  const u = String(c ?? "").replace(/\s/g, "");
  if (/^[-–]$/.test(u)) return 0;
  if (!/^\(?-?[\d,]+\)?$/.test(u)) return null;
  const v = Number(u.replace(/[(),-]/g, ""));
  return /^[(-]/.test(u) ? -v : v;
};
function kindOf(l) {
  if (/^(감가상각비(및|와|,)무형자산(감가)?상각비|감가상각비및상각비|유·?무형자산상각비|유형및무형자산상각비)$/.test(l)) return "comb";
  if (/사용권자산/.test(l) && /상각/.test(l)) return "rou";
  if (/투자부동산/.test(l) && /상각/.test(l)) return "inv";
  if (/^무형자산(감가)?상각비$/.test(l)) return "amo";
  if (/^(유형자산)?감가상각비$|^유형자산상각비$/.test(l)) return "dep";
  return null;
}

/** 표 목록 → 후보 [{ v, how }] (원 단위). 표 단위를 모르면 그 표는 건너뛴다 */
export function daCandidates(tables) {
  const out = [];
  tables.forEach((t, ti) => {
    if (!t.unit) return;
    const segs = [];
    let cur = null;
    for (const r of t.rows) {
      const k = kindOf(lab(r[0]));
      if (!k) continue;
      if (!cur || (k in cur && (k === "dep" || k === "comb"))) { cur = {}; segs.push(cur); }
      if (!(k in cur)) cur[k] = r.slice(1).map(num);
    }
    segs.forEach((s, si) => {
      const width = Math.max(0, ...Object.values(s).map((a) => a.length));
      for (let j = 0; j < width; j++) {
        const g = (k) => s[k]?.[j] ?? null;
        const add = (v, how) => { if (v != null && Number.isFinite(v) && v !== 0) out.push({ v: v * t.unit, how: `표${ti + 1}·묶음${si + 1}·열${j + 1} ${how}` }); };
        if (g("comb") != null) { add(g("comb"), "합친 줄"); if (g("rou") != null) add(g("comb") + g("rou"), "합친 줄 + 사용권"); }
        if (g("dep") != null) {
          const d = g("dep"), a = g("amo") ?? 0, ro = g("rou"), iv = g("inv");
          add(d + a, "감가 + 무형");
          if (ro != null) add(d + ro + a, "감가 + 사용권 + 무형");
          if (iv != null) add(d + iv + a, "감가 + 투자부동산 + 무형");
          if (ro != null && iv != null) add(d + ro + iv + a, "감가 + 사용권 + 투자부동산 + 무형");
          // 투자부동산 상각을 뺀 값(적재 「−투자부동산」 — 그 보고서에만 따로 있는 투자부동산 줄을 뺀 이듬해 판본 기준, SK하이닉스 2021)
          if (iv != null) add(d - iv + a, "감가 − 투자부동산 + 무형");
        }
      }
    });
  });
  return out;
}

/** 원문 줄 하나(사용권자산·투자부동산 상각·무형자산상각)의 열별 값 [{ v, kind, how }] — XBRL 기본 감가상각에 원문 줄을 더한 적재 값(xbrl+doc·+원문무형) 대조용 */
export function docExtraRows(tables) {
  const out = [];
  tables.forEach((t, ti) => {
    if (!t.unit) return;
    for (const r of t.rows) {
      const k = kindOf(lab(r[0]));
      if (k !== "rou" && k !== "inv" && k !== "amo") continue;
      r.slice(1).map(num).forEach((v, j) => { if (v != null && v !== 0) out.push({ v: v * t.unit, kind: k, how: `표${ti + 1}·열${j + 1} ${{ rou: "사용권", inv: "투자부동산", amo: "무형" }[k]}` }); });
    }
  });
  return out;
}
