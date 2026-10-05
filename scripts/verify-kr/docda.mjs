/**
 * 검증기 — 원문 감가상각 표 판독(감사 2차·3차 2026-10-05). 감가상각 적재본(kr_da) 중 XBRL 로 재현되지 않는 칸(원문 현금흐름 조정 주석 해, 영업비용 기준
 * 성격별 비용 표 해, 사용권자산 줄 원문 보완 해, TTM 누적)을 **검증기가 원문 표를 따로 읽어** 대조한다. 앱 적재 스크립트(populate-kr-da.mjs)의 판독
 * 코드(parseDocDa·parseNatureDa 등)를 가져오지 않는다 — 규칙 문장(감가상각 = 유형 + 사용권자산 + 투자부동산 감가상각 + 무형자산상각, 또는 합친 줄)만
 * 보고 다시 짠 판독.
 *
 * 감사 3차(확정 판독만): 예전엔 표마다 다섯 가지 조합(감가 + 무형, 감가 + 사용권 + 무형 …)과 모든 열을 후보로 내 사용권·투자부동산을 뺀 값도 통과했다.
 *  · 표 종류 = 주석 제목(dart.mjs section)으로 — 성격별(nature)·현금흐름(cf)·투자부동산 변동표(inv)만. 판관비·부문·유형자산 변동표는 쓰지 않는다
 *  · 조합은 **하나** — 그 표 묶음에 있는 구성요소를 모두 더한다: (합친 줄 또는 감가) + 사용권 줄(있으면) + 투자부동산 줄(있으면) + 무형 줄(있으면, 합친 줄이
 *    아니면). 투자부동산 줄을 뺀 값(vNoInv)은 적재 출처가 「−투자부동산」일 때만 호출부가 쓴다
 *  · 열 = 머리행으로 판독 — 당기·전기(당반기·전반기)와 3개월·누적. 머리행에 기간이 없으면 표 앞 기간 표시(dart.mjs period). 같은 기간·누적 구분 열이
 *    여럿이면(성격별 표의 매출원가·판관비·합계 등) 마지막 열(합계)만
 */
const lab = (s) => String(s ?? "").replace(/^[\s\-–·ㆍ•\d.)]+/, "").replace(/\(주\s*\d+[^)]*\)/g, "").replace(/\s/g, "");
const num = (c) => {
  const u = String(c ?? "").replace(/\s/g, "");
  if (/^[-–]$/.test(u)) return 0;
  if (!/^[(△]?-?[\d,]+\)?$/.test(u)) return null;
  const v = Number(u.replace(/[(),\-△]/g, ""));
  return /^[(\-△]/.test(u) ? -v : v;
};
function kindOf(l) {
  // "감가상각비(유,무형자산 및 투자부동산)"(000500 성격별·현금흐름 조정) — 괄호 안이 무형자산을 포함한다고 밝힌 감가상각비 = 합친 줄
  const paren = l.match(/\((.*?)\)/)?.[1] ?? "";
  if (l.replace(/\(.*?\)/g, "") === "감가상각비" && paren) {
    // "감가상각비(유형자산)"·"(무형자산)"·"(투자부동산)"·"(사용권자산)"(298040 현금흐름 조정) — 괄호가 하나만 가리키면 그 구성요소
    if (/유,?무형|유형.*무형/.test(paren)) return "comb";
    if (/무형/.test(paren)) return "amo";
    if (/투자부동산/.test(paren)) return "inv";
    if (/사용권/.test(paren)) return "rou";
    if (/유형/.test(paren)) return "dep";
  }
  if (/^(감가상각비(및|와|,)무형자산(감가)?상각(비)?|감가상각비및상각비|유·?무형자산상각비|유형및무형자산상각비)$/.test(l)) return "comb";
  // XBRL 표준 이름 꼴 줄 이름("감가상각비, 유형자산"·"기타 상각비, 영업권 이외의 무형자산" — 051600 2025 성격별 표)
  if (/^감가상각비,유형자산$/.test(l)) return "dep";
  if (/^감가상각비,투자부동산$/.test(l)) return "inv";
  if (/^감가상각비,사용권자산$/.test(l)) return "rou";
  if (/^(기타)?상각비,영업권이외의무형자산$/.test(l)) return "amo";
  if (/사용권자산/.test(l) && /상각/.test(l)) return "rou";
  if (/투자부동산/.test(l) && /상각/.test(l)) return "inv";
  if (/^무형자산(감가)?상각비$/.test(l)) return "amo";
  if (/^(유형자산)?감가상각비$|^유형자산상각비$/.test(l)) return "dep";
  return null;
}
/** 표 종류 — 주석 제목으로 */
export function tableKind(t) {
  const s = t.section ?? "";
  if (/성격별/.test(s)) return "nature";
  if (/투자부동산/.test(s)) return "inv";
  if (/현금흐름|영업으로부터\s*창출|영업활동/.test(s)) return "cf";
  return null;
}
/** 열 j 의 (기간, 누적) — 머리행 판독. 기간: "cur"·"prior"·null(표 앞 기간 표시를 씀), 누적: true·false·null */
function columns(t) {
  const isData = (r) => r.slice(1).some((c) => num(c) != null && String(c).trim() !== "-");
  const first = t.rows.findIndex(isData);
  const hdrs = (first < 0 ? [] : t.rows.slice(0, first)).filter((r) => r.slice(1).some((c) => String(c).trim()));
  const width = Math.max(0, ...t.rows.filter(isData).map((r) => r.length - 1));
  const cols = [];
  for (let j = 0; j < width; j++) {
    let period = null, cum = null;
    for (const h of hdrs) {
      // 머리 줄이 자료 줄보다 길면(빈 머리 칸 — 052690 "| | 매출원가 3개월 | 누적 …") 오른쪽 끝에서 맞춘다. 짧으면 열을 정할 수 없어 쓰지 않는다
      const off = h.length - 1 - width;
      if (off < 0) continue;
      const l = String(h[1 + off + j] ?? "").replace(/\s/g, "");
      // "당기"·"당반기"·"제 21(당) 기" / "전기"·"전반기"·"제 20(전) 기"
      if (/^(당|금)(반기|분기|기)|\(당\)/.test(l)) period = "cur";
      else if (/^전(반기|분기|기)|\(전\)/.test(l)) period = "prior";
      if (/누적/.test(l)) cum = true;
      else if (/3개월/.test(l)) cum = false;
    }
    cols.push({ period: period ?? t.period ?? null, cum });
  }
  return { cols };
}

/**
 * 표 목록 → 확정 후보 [{ v, vNoInv, comps, scope, kind, period, cum, sig, how }] (원 단위). 표 단위·종류를 모르면 그 표는 건너뛴다
 */
export function daCandidates(tables) {
  const out = [];
  tables.forEach((t, ti) => {
    const kind = tableKind(t);
    if (!t.unit || (kind !== "nature" && kind !== "cf")) return;
    const { cols } = columns(t);
    const segs = [];
    let cur = null;
    for (const r of t.rows) {
      const k = kindOf(lab(r[0]));
      if (!k) continue;
      if (!cur || (k in cur && (k === "dep" || k === "comb"))) { cur = {}; segs.push(cur); }
      if (!(k in cur)) cur[k] = r.slice(1).map(num);
    }
    segs.forEach((s, si) => {
      // 같은 (기간, 누적) 열이 여럿이면 그 묶음에 값이 있는 마지막 열만(성격별 표 합계 열, "당기 | 당기 | 전기 | 전기" 두 칸 머리 — 064350 2021)
      const has = (j) => { const b = s.comb?.[j] ?? s.dep?.[j] ?? null; return b != null && b !== 0; };
      for (let j = 0; j < cols.length; j++) {
        if (!has(j) || cols.some((d, k) => k > j && has(k) && d.period === cols[j].period && d.cum === cols[j].cum)) continue;
        const g = (k) => s[k]?.[j] ?? null;
        const base = g("comb") ?? g("dep");
        const rou = g("rou"), inv = g("inv"), amo = g("comb") != null ? null : g("amo");
        const sig = [g("comb") != null ? "comb" : "dep", rou != null && "rou", inv != null && "inv", amo != null && "amo"].filter(Boolean).join("+");
        const v = base + (rou ?? 0) + (inv ?? 0) + (amo ?? 0);
        out.push({
          v: v * t.unit, vNoInv: inv != null ? (v - inv) * t.unit : null, comps: { rou: rou == null ? null : rou * t.unit, inv: inv == null ? null : inv * t.unit, amo: amo == null ? null : amo * t.unit },
          scope: t.scope ?? null, kind, period: cols[j].period, cum: cols[j].cum, sig, unit: t.unit,
          how: `표${ti + 1}[${t.section ?? "?"}${t.scope ? `·${t.scope === "con" ? "연결" : "별도"}` : ""}]·묶음${si + 1}·열${j + 1}(${cols[j].period ?? "?"}${cols[j].cum === true ? "·누적" : cols[j].cum === false ? "·3개월" : ""}) ${sig}`,
        });
      }
    });
  });
  return out;
}

/** 투자부동산 변동표의 감가상각(「+투자부동산」 적재 — 성격별 합계 + 투자부동산 감가상각) — [{ v, scope, period, how }], 마지막 숫자 열(합계)의 절댓값 */
export function invTableDep(tables) {
  const out = [];
  tables.forEach((t, ti) => {
    if (!t.unit || tableKind(t) !== "inv") return;
    for (const r of t.rows) {
      if (!/^감가상각(비)?$/.test(lab(r[0]))) continue;
      const vs = r.slice(1).map(num).filter((x) => x != null && x !== 0);
      if (vs.length) out.push({ v: Math.abs(vs.at(-1)) * t.unit, scope: t.scope ?? null, period: t.period ?? null, how: `표${ti + 1}[${t.section}] 투자부동산 감가상각` });
    }
  });
  return out;
}
