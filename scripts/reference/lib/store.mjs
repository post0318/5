/**
 * 독립 기준 저장소 — scripts/reference/data/us/{SYM}.json (git 추적).
 *
 * 절대 조용히 덮어쓰지 않는다: 같은 (공시번호, 행, 열) 값이 이미 있고 다르면 둘 다 남기고
 * conflict 로 표시한다. 같으면 confirmedBy 에 이번 추출을 덧붙인다(재추출 확인 기록).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "..", "data", "us");

export function dataPath(symbol) {
  return join(DATA_DIR, `${symbol.toUpperCase()}.json`);
}

export async function loadStore(symbol) {
  try {
    const store = JSON.parse(await readFile(dataPath(symbol), "utf8"));
    // 추출기(by) 기록 이전 값은 extractions 의 어댑터 이름으로 채운다(값 자체는 그대로)
    store.values = store.values.map((v) => (v.by ? v : { x: v.x, by: store.extractions[v.x]?.adapter, ...v }));
    return store;
  } catch {
    return {
      symbol: symbol.toUpperCase(),
      cik: null,
      entityName: null,
      note:
        "독립 기준 — SEC 원문(10-K/10-Q/20-F 본문 HTML)의 손익계산서 표를 인쇄된 그대로 옮긴 값. " +
        "XBRL·companyfacts·앱·검증기 코드를 쓰지 않는다. 손으로 고치지 말고 재추출(인용 포함)로만 바꾼다.",
      format: FORMAT,
      extractions: {},
      values: [],
      conflicts: [],
    };
  }
}

/**
 * 저장 형식 2(압축): 공시(추출)별 메타 — 문서 URL·표 제목·단위 문구·모델·버전·시각·지시문 해시·
 * 열 파싱(기간 말일·길이) — 는 extractions[id] 에 한 번만 두고, 값은 그 id 를 참조한다.
 *
 * 값 한 줄 필드:
 *   x       extractionId(공시번호·어댑터·시각이 들어 있음 → extractions[x] 로 인용 정보 복원)
 *   by      추출기 — "parser"(결정적 코드) | "gemini" 등 모델 어댑터 이름
 *   row     표 안 행 순서(0부터)
 *   sec     구역 제목(없으면 생략)       label  행 제목(인쇄 그대로)
 *   occ     같은 구역·행 제목이 표에 두 번 이상일 때 몇 번째인지(2부터, 1이면 생략)
 *   col     열 제목(인쇄 그대로)
 *   printed 인쇄된 숫자 문자열(괄호·$ 제외)   neg  괄호/마이너스 음수(참일 때만)
 *   value   배수 적용 값(금액 달러 정수·주식 수 정수·주당 금액 소수 문자열, 대시는 null)
 *   scale   배수                            unit   currency|per_share|shares|percent|other
 *   sub     소계 행(참일 때만)
 *   confirmedBy / conflict  재추출 확인 기록 / 충돌 표시(있을 때만)
 *
 * 키(충돌 판정) = 공시번호|구역|행 제목(#occ)|열 제목 — 형식 1 과 같다(keyOf).
 */
export const FORMAT = 2;

/** 검증기 칸 → 압축 값 */
export function toCompact(extractionId, c, by) {
  const occ = /#(\d+)$/.exec(c.rowKey)?.[1];
  const v = { x: extractionId, by, row: c.rowIndex };
  if (c.sectionLabel) v.sec = c.sectionLabel;
  v.label = c.label;
  if (occ) v.occ = Number(occ);
  v.col = c.columnHeader;
  v.printed = c.printed;
  if (c.negative) v.neg = true;
  v.value = c.value;
  v.scale = c.scale;
  v.unit = c.unitKind;
  if (c.isSubtotal) v.sub = true;
  return v;
}

export function keyOf(store, v) {
  const acc = store.extractions[v.x]?.accession ?? v.x.split("@")[0];
  return `${acc}|${v.sec ?? ""}|${v.label}${v.occ ? "#" + v.occ : ""}|${v.col}`;
}

/** 압축 값 → 인용·추출 정보를 붙인 전체 레코드(소비하는 쪽 편의용) */
export function expandValue(store, v) {
  const e = store.extractions[v.x];
  const col = e?.validation?.columns?.find((c) => c.header === v.col);
  return {
    key: keyOf(store, v),
    accession: e?.accession,
    documentUrl: e?.documentUrl,
    tableTitle: e?.tableTitle,
    unitCaption: e?.unitCaption,
    rowIndex: v.row,
    columnIndex: col?.columnIndex ?? null,
    sectionLabel: v.sec ?? "",
    label: v.label,
    columnHeader: v.col,
    periodEnd: col?.periodEnd ?? null,
    durationMonths: col?.durationMonths ?? null,
    durationWeeks: col?.durationWeeks ?? null,
    printed: v.printed,
    negative: Boolean(v.neg),
    nil: v.value === null,
    unitKind: v.unit,
    scale: v.scale,
    value: v.value,
    isSubtotal: Boolean(v.sub),
    model: e?.model,
    version: e?.version,
    extractedAt: e?.extractedAt,
    promptHash: e?.promptHash,
    extractionId: v.x,
    extractor: v.by,
    ...(v.confirmedBy ? { confirmedBy: v.confirmedBy } : {}),
    ...(v.conflict ? { conflict: true } : {}),
  };
}

export async function saveStore(store) {
  store.format = FORMAT;
  const acc = (v) => store.extractions[v.x]?.accession ?? "";
  const colIdx = (v) => store.extractions[v.x]?.validation?.columns?.find((c) => c.header === v.col)?.columnIndex ?? 99;
  store.values.sort((a, b) => acc(a).localeCompare(acc(b)) || a.row - b.row || colIdx(a) - colIdx(b) || a.x.localeCompare(b.x));
  await mkdir(DATA_DIR, { recursive: true });
  const path = dataPath(store.symbol);
  // 값은 한 줄에 하나(git diff 가 값 단위로 보인다), 나머지는 들여쓰기
  const { values, ...rest } = store;
  const head = JSON.stringify({ ...rest, values: [] }, null, 1).replace(/"values": \[\]\n\}$/, "");
  const body = values.map((v) => "  " + JSON.stringify(v)).join(",\n");
  await writeFile(path, `${head}"values": [${values.length ? "\n" + body + "\n " : ""}]\n}\n`, "utf8");
  return path;
}

export function alreadyExtracted(store, accession, adapterName, promptHash) {
  return Object.values(store.extractions).some(
    (e) => e.accession === accession && e.adapter === adapterName && e.promptHash === promptHash && e.status === "ok",
  );
}

const sameValue = (a, b) =>
  a.printed === b.printed && Boolean(a.neg) === Boolean(b.neg) && String(a.value) === String(b.value) && a.scale === b.scale;

/**
 * 검증 통과 칸을 저장소에 합친다. store.extractions[extractionId] 가 먼저 들어 있어야 한다.
 * @returns {{ added: number; confirmed: number; conflicts: number }}
 */
export function mergeCells(store, extractionId, cells) {
  let added = 0;
  let confirmed = 0;
  let conflicts = 0;
  for (const c of cells) {
    const rec = toCompact(extractionId, c, store.extractions[extractionId]?.adapter);
    const key = keyOf(store, rec);
    const existing = store.values.filter((v) => keyOf(store, v) === key);
    if (!existing.length) {
      store.values.push(rec);
      added++;
      continue;
    }
    const same = existing.find((v) => sameValue(v, rec));
    if (same) {
      same.confirmedBy = [...new Set([...(same.confirmedBy ?? []), extractionId])];
      confirmed++;
      continue;
    }
    // 다른 값 — 둘 다 남기고 충돌 표시
    rec.conflict = true;
    for (const v of existing) v.conflict = true;
    store.values.push(rec);
    let entry = store.conflicts.find((x) => x.key === key);
    if (!entry) {
      entry = { key, extractionIds: [...new Set(existing.map((v) => v.x))] };
      store.conflicts.push(entry);
    }
    entry.extractionIds.push(extractionId);
    conflicts++;
  }
  return { added, confirmed, conflicts };
}
