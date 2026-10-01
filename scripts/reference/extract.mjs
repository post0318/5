/**
 * 독립 기준 추출 — SEC 원문 손익계산서 표를 읽어, 결정적 검증기로 원문과 대조해 저장한다.
 *
 * 추출 = "코드 파서 우선 + LLM 보조"(오너 결정 2026-09-26, 비용 절감):
 *  1) 결정적 파서(lib/parse.mjs)가 먼저 읽는다 — 비용 0.
 *  2) LLM(어댑터)은 (a) 파서가 표를 못 읽었거나 검증에서 칸이 거부된 공시, (b) 교차 확인 표본에만 부른다.
 *     표본 = sha256(공시번호) 앞 8자리 % REF_LLM_SAMPLE == 0 (결정적, 기본 10 → 약 10건 중 1건).
 *  3) 파서·LLM 값이 같으면 confirmedBy 로 재확인 기록, 다르면 둘 다 남기고 conflict — 한쪽을 조용히 채택하지 않는다.
 *
 *   node scripts/reference/extract.mjs --symbols=AAPL,MRVL
 *   node scripts/reference/extract.mjs --symbols=AAPL --10q=1
 *   node scripts/reference/extract.mjs --symbols=MRVL --include=0001835632-22-000016
 *   node scripts/reference/extract.mjs --symbols=AAPL --dry                  # 표 위치·파서 결과만(저장·모델 호출 없음)
 *   node scripts/reference/extract.mjs --symbols=AAPL --offline --llm=never  # SEC 캐시만, 파서만
 *
 * 옵션
 *   --10q=N          최근 10-Q 몇 개(기본 4)
 *   --annual=N       최근 10-K/20-F 몇 개(기본 1)
 *   --include=ACC,.. 그 종목의 제출 목록에 있는 공시번호를 추가로 포함
 *   --adapter=gemini LLM 어댑터(기본 gemini)
 *   --llm=auto|always|never  auto(기본: 실패·표본만) / always(모든 공시 교차 확인) / never(파서만)
 *   --force          같은 공시를 같은 추출기(같은 파서 해시·지시문 해시)로 이미 뽑았어도 다시 뽑는다
 *   --offline        SEC 에 요청하지 않고 .cache 만 쓴다(없으면 오류)
 *   --dry            저장·모델 호출 없이 표 위치와 파서 결과만 출력
 *
 * 환경변수: SEC_USER_AGENT, GEMINI_API_KEY, REF_GEMINI_MODEL, REF_BUDGET_USD(기본 1.0), REF_LLM_SAMPLE(기본 10, 0=표본 없음)
 *
 * 청정실 규칙: 이 모듈은 src/lib/** 나 scripts/verify-financials.mjs 를 import 하지 않는다.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cikForTicker, documentUrl, listFilings, secFetch, setOffline, CACHE_DIR } from "./lib/sec.mjs";
import { locateIncomeStatement } from "./lib/locate.mjs";
import { parseIncomeStatement, PARSER_HASH, PARSER_VERSION } from "./lib/parse.mjs";
import { INSTRUCTIONS, SCHEMA, PROMPT_HASH, PROMPT_VERSION } from "./lib/prompt.mjs";
import { validateExtraction } from "./lib/validate.mjs";
import { loadStore, saveStore, mergeCells, alreadyExtracted } from "./lib/store.mjs";
import { createGeminiAdapter } from "./adapters/gemini.mjs";
import { createOpenAIAdapter } from "./adapters/openai.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(HERE, "..", "..", ".env.local"));
} catch {
  // 환경변수로 직접 줘도 된다
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const symbols = String(args.symbols ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
if (!symbols.length) {
  console.error("사용법: node scripts/reference/extract.mjs --symbols=AAPL,MRVL [--10q=4] [--include=ACC] [--llm=auto|always|never] [--offline] [--dry]");
  process.exit(2);
}
const n10q = Number(args["10q"] ?? 4);
const nAnnual = Number(args.annual ?? 1);
const includes = String(args.include ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const dry = Boolean(args.dry);
const force = Boolean(args.force);
const llmMode = String(args.llm ?? "auto");
if (!["auto", "always", "never"].includes(llmMode)) throw new Error(`--llm 값 오류: ${llmMode}`);
const budget = Number(process.env.REF_BUDGET_USD ?? 1.0);
const sampleEvery = Number(process.env.REF_LLM_SAMPLE ?? 10);
if (args.offline) setOffline(true);

const ADAPTERS = { gemini: createGeminiAdapter, openai: createOpenAIAdapter };
const adapterName = String(args.adapter ?? "gemini");
if (!ADAPTERS[adapterName]) throw new Error(`알 수 없는 어댑터: ${adapterName}`);
const adapter = ADAPTERS[adapterName]();

let spent = 0;
const tally = { filings: 0, parserOk: 0, parserFail: 0, llmCalls: 0, llmForFailure: 0, llmForSample: 0 };
const DISPLAY_RE = /revenue|net sales|^sales|cost of|gross|operating income|income from operations|operating (?:loss|profit)|loss from operations/i;

/** 교차 확인 표본 — 공시번호 해시로 결정적으로 고른다(실행할 때마다 같은 공시) */
export function isSampled(accession, every = sampleEvery) {
  if (!every || every <= 0) return false;
  const h = parseInt(createHash("sha256").update(accession).digest("hex").slice(0, 8), 16);
  return h % every === 0;
}

function pickFilings(filings) {
  const clean = filings.filter((f) => f.primaryDocument && /\.html?$/i.test(f.primaryDocument));
  const annual = clean.filter((f) => f.form === "10-K" || f.form === "20-F").slice(0, nAnnual);
  const quarterly = clean.filter((f) => f.form === "10-Q").slice(0, n10q);
  const extra = includes.map((acc) => clean.find((f) => f.accession === acc)).filter(Boolean);
  const seen = new Set();
  return [...annual, ...quarterly, ...extra].filter((f) => !seen.has(f.accession) && seen.add(f.accession));
}

function filingMeta(f, url, loc) {
  return {
    accession: f.accession,
    form: f.form,
    filingDate: f.filingDate,
    reportDate: f.reportDate,
    documentUrl: url,
    heading: loc.heading,
  };
}

/** 검증 결과를 추출 기록·값으로 저장하고 로그를 남긴다 */
function record(store, { f, url, loc, extractor, model, version, hash, hashKind, json, usage, v }) {
  const extractedAt = new Date().toISOString();
  const extractionId = `${f.accession}@${extractor}@${extractedAt}`;
  store.extractions[extractionId] = {
    ...filingMeta(f, url, loc),
    tableTitle: json?.tableTitle ?? null,
    unitCaption: json?.unitCaption ?? null,
    adapter: extractor,
    model,
    version,
    extractedAt,
    promptVersion: hashKind === "parser" ? PARSER_VERSION : PROMPT_VERSION,
    promptHash: hash, // 파서는 파서 소스 해시, LLM 은 지시문·스키마 해시
    usage,
    status: !v.ok ? "schema_error" : v.rejected.length ? "partial" : "ok",
    validation: {
      accepted: v.cells.length,
      rejected: v.rejected.length,
      schemaErrors: v.schemaErrors,
      warnings: v.warnings,
      columns: v.columns.map(({ columnIndex, header, periodEnd, durationMonths, durationWeeks }) => ({
        columnIndex, header, periodEnd, durationMonths, durationWeeks,
      })),
    },
    rejected: v.rejected,
  };
  const m = v.ok ? mergeCells(store, extractionId, v.cells) : { added: 0, confirmed: 0, conflicts: 0 };
  console.log(
    `  [${extractor}] 검증: 통과 ${v.cells.length} / 거부 ${v.rejected.length} / 경고 ${v.warnings.length} → 추가 ${m.added}, 재확인 ${m.confirmed}, 충돌 ${m.conflicts}`,
  );
  for (const e of v.schemaErrors.slice(0, 3)) console.log(`   스키마: ${e}`);
  for (const w of v.warnings) console.log(`   경고: ${w}`);
  for (const r of v.rejected) console.log(`   거부: [${r.label} | ${r.columnHeader}] "${r.printed}" — ${r.reasons.join("; ")}`);
  return m;
}

function display(json, v) {
  console.log(`  표: ${json.tableTitle} ${json.unitCaption}`);
  for (const c of v.cells.filter((c) => DISPLAY_RE.test(c.label) || DISPLAY_RE.test(c.sectionLabel))) {
    console.log(
      `   ${c.isSubtotal ? "Σ" : " "} ${(c.sectionLabel ? c.sectionLabel + " › " : "") + c.label} | ${c.columnHeader} | "${c.negative ? "(" + c.printed + ")" : c.printed}" ×${c.scale} = ${c.value}`,
    );
  }
}

async function processSymbol(sym) {
  console.log(`\n══ ${sym} ══`);
  const cik = await cikForTicker(sym);
  let { entityName, filings } = await listFilings(cik);
  if (includes.some((acc) => !filings.some((f) => f.accession === acc))) {
    ({ entityName, filings } = await listFilings(cik, { needOlder: true }));
  }
  const store = await loadStore(sym);
  store.cik = cik;
  store.entityName = entityName;

  for (const f of pickFilings(filings)) {
    tally.filings++;
    const url = documentUrl(cik, f.accession, f.primaryDocument);
    console.log(`\n· ${f.form} ${f.accession} (제출 ${f.filingDate}, 기준일 ${f.reportDate})`);
    console.log(`  ${url}`);
    const doc = await secFetch(url);
    const loc = locateIncomeStatement(doc.text);
    if (!loc) {
      console.log(`  ✗ 손익계산서 표를 못 찾음(원문 ${(doc.text.length / 1024).toFixed(0)}KB) — 파서·LLM 모두 건너뜀`);
      continue;
    }
    console.log(
      `  표 위치: "${loc.heading}" 점수 ${loc.score}, 원문 ${(doc.text.length / 1024).toFixed(0)}KB → 창 ${(loc.windowHtml.length / 1024).toFixed(1)}KB`,
    );

    // 1) 결정적 파서
    const p = parseIncomeStatement(loc.windowHtml, loc.windowText);
    const pv = p.json ? validateExtraction(p.json, SCHEMA, loc.windowText) : null;
    const parserOk = Boolean(pv?.ok && !pv.rejected.length && pv.cells.length && pv.columns.every((c) => c.periodEnd));
    if (parserOk) tally.parserOk++;
    else tally.parserFail++;
    const parserWhy = !p.json ? p.reason : !pv.ok ? "스키마 불일치" : pv.rejected.length ? `검증 거부 ${pv.rejected.length}칸` : !pv.cells.length ? "칸 없음" : "열 기간 파싱 실패";
    console.log(`  파서: ${parserOk ? `성공 ${pv.cells.length}칸` : `실패 — ${parserWhy}`}`);
    const sampled = isSampled(f.accession);
    const needLlm = llmMode === "always" || (llmMode === "auto" && (!parserOk || sampled));
    if (dry) {
      if (pv?.ok) display(p.json, pv);
      console.log(`  LLM: ${needLlm ? (parserOk ? "표본 교차 확인 대상" : "파서 실패 → 호출 대상") : "호출 안 함"} (dry — 저장 안 함)`);
      continue;
    }
    if (p.json && (force || !alreadyExtracted(store, f.accession, "parser", PARSER_HASH))) {
      record(store, {
        f, url, loc, extractor: "parser", model: PARSER_VERSION, version: PARSER_HASH, hash: PARSER_HASH, hashKind: "parser",
        json: p.json, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, v: pv,
      });
      if (pv.ok) display(p.json, pv);
    } else if (p.json) {
      console.log("  [parser] 이미 같은 파서 해시로 추출됨 — 건너뜀");
    }
    await saveStore(store);

    // 2) LLM — 파서 실패 또는 교차 확인 표본만
    if (!needLlm) continue;
    if (!force && alreadyExtracted(store, f.accession, adapter.name, PROMPT_HASH)) {
      console.log(`  [${adapter.name}] 이미 같은 지시문으로 추출됨 — 건너뜀`);
      continue;
    }
    const input = { html: loc.windowHtml, instructions: INSTRUCTIONS, schema: SCHEMA };
    const est = adapter.estimateCostUsd(input);
    if (spent + est > budget) {
      console.log(`  ✗ 예산 초과 예상(누적 $${spent.toFixed(4)} + 추정 $${est.toFixed(4)} > $${budget}) — 중단`);
      return { stop: true };
    }
    console.log(`  [${adapter.name}] 호출 사유: ${parserOk ? "교차 확인 표본" : `파서 실패(${parserWhy})`}`);
    let out;
    try {
      out = await adapter.extract(input);
    } catch (e) {
      if (e.usage) spent += e.usage.costUsd;
      console.log(`  ✗ 모델 호출 실패: ${e.message}`);
      continue;
    }
    tally.llmCalls++;
    if (parserOk) tally.llmForSample++;
    else tally.llmForFailure++;
    spent += out.usage.costUsd;
    console.log(
      `  [${adapter.name}] ${out.model} (${out.version}) 입력 ${out.usage.inputTokens} / 출력 ${out.usage.outputTokens} 토큰, $${out.usage.costUsd.toFixed(4)} (누적 $${spent.toFixed(4)})`,
    );
    const rawDir = join(CACHE_DIR, "..", "model");
    await mkdir(rawDir, { recursive: true });
    await writeFile(join(rawDir, `${sym}_${f.accession}_${adapter.name}_${Date.now()}.json`), JSON.stringify(out, null, 1));
    const lv = validateExtraction(out.json, SCHEMA, loc.windowText);
    record(store, {
      f, url, loc, extractor: adapter.name, model: out.model, version: out.version, hash: PROMPT_HASH, hashKind: "llm",
      json: out.json, usage: out.usage, v: lv,
    });
    if (!parserOk && lv.ok) display(out.json, lv);
    const path = await saveStore(store);
    console.log(`  저장: ${path}`);
  }
  return { stop: false };
}

for (const sym of symbols) {
  const r = await processSymbol(sym);
  if (r.stop) break;
}
console.log(
  `\n공시 ${tally.filings}건: 파서 성공 ${tally.parserOk} / 실패 ${tally.parserFail}, LLM 호출 ${tally.llmCalls}(실패 보완 ${tally.llmForFailure}, 표본 ${tally.llmForSample})`,
);
console.log(`실행 비용 합계: $${spent.toFixed(4)} (상한 $${budget})`);
