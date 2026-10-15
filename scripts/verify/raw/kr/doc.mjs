/**
 * 한국 사업보고서 원문 판독 공통(설계 10 R-KR7) — document.xml zip 의 문서마다 UTF-8 로 읽다가 깨지면 EUC-KR(옛 원문은 선언이 utf-8 이지만 실제 EUC-KR).
 * 범위 = 첨부 종류(연결감사보고서 → 연결, 감사보고서 → 별도) → 본문 목차 → 주석 제목. 표 단위 = 표 안 첫 「(단위 : …)」 → 없으면 표 앞 1,500자의 마지막 단위.
 * 숫자는 원문 문자열 → 정수 문자열(표 단위 배수는 정수 곱) — 부동소수 안 씀.
 */
import { unzipEntries } from "../common/format.mjs";
import { scaleInt } from "../common/rawfact.mjs";

/** zip → [{ name, docName, x(원문 문자열), enc }] */
export function docFiles(buf) {
  const out = [];
  for (const e of unzipEntries(buf).sort((a, b) => a.name.localeCompare(b.name))) {
    let x, enc = "utf-8";
    try {
      x = new TextDecoder("utf-8", { fatal: true }).decode(e.data);
    } catch {
      // 선언은 utf-8 인데 실제 EUC-KR(옛 원문) — 실패를 삼키지 않고 인코딩을 바꿔 다시 읽는다(결과에 enc 기록)
      x = new TextDecoder("euc-kr").decode(e.data);
      enc = "euc-kr";
    }
    const dn = /<DOCUMENT-NAME[^>]*>([^<]*)</.exec(x)?.[1]?.trim() ?? "";
    out.push({ name: e.name, docName: dn, x, enc });
  }
  return out;
}

const ENT = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
export function text(s) {
  return String(s).replace(/&cr;/g, " ").replace(/<[^>]+>/g, " ").replace(/&(lt|gt|amp|quot|apos|nbsp);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/\s+/g, " ").trim();
}
export function cells(tr) {
  return [...tr.matchAll(/<T[DHE]\b[^>]*>([\s\S]*?)<\/T[DHE]>/gi)].map((m) => text(m[1]));
}
/** 칸 문자열 → 정수·소수 문자열(부호: (…)·△·-) 또는 null */
export function cellNum(s) {
  const t = String(s).replace(/\s/g, "");
  if (!/\d/.test(t)) return null;
  const neg = (/^\(.*\)$/.test(t)) || /^[△▲-]/.test(t);
  const d = t.replace(/[^\d.]/g, "");
  if (!/^\d+(\.\d+)?$/.test(d)) return null;
  const n = d.replace(/^0+(?=\d)/, "");
  return neg && n !== "0" ? `-${n}` : n;
}
const UNIT = /단위\s*[:：]?\s*(백만\s*원|천\s*원|원|USD|달러)/g;
export const UNIT_EXP = { "백만원": 6, "천원": 3, "원": 0 };

/** 연결 주석 영역 [{ file, docName, a, b, src }] — 본문 「연결재무제표 주석」 절, 없으면 연결감사보고서 첨부 */
export function consolidatedNoteRegions(fs) {
  const out = [];
  for (const f of fs) {
    if (!(f.docName.startsWith("사업보고서") || !f.name.includes("_"))) continue;
    const ts = [...f.x.matchAll(/<TITLE[^>]*>([\s\S]*?)<\/TITLE>/g)].map((m) => [m.index, text(m[1])]);
    ts.forEach(([pos, t], i) => {
      if (!/연결\s*재무제표\s*주석/.test(t)) return;
      const end = ts.slice(i + 1).find(([, tt]) => /재무제표|배당|기타\s*재무|감사/.test(tt))?.[0] ?? f.x.length;
      out.push({ file: f.name, docName: f.docName, a: pos, b: end, src: "본문 연결재무제표 주석" });
    });
  }
  for (const f of fs) if (/연결\s*감사\s*보고서/.test(f.docName)) out.push({ file: f.name, docName: f.docName, a: 0, b: f.x.length, src: `첨부 ${f.docName}` });
  return out;
}

/** 영역 안 주석 제목(번호가 1씩 늘어나는 「N. 제목」만) */
export function headings(x, a, b) {
  const out = [];
  let cur = 0;
  for (const m of x.slice(a, b).matchAll(/<(?:P|TD|SPAN|TITLE)[^>]*>([\s\S]*?)<\/(?:P|TD|SPAN|TITLE)>/g)) {
    const t = text(m[1]);
    const h = /^(\d{1,2})\s*\.\s*([^:：]{2,50})/.exec(t);
    if (!h) continue;
    const n = Number(h[1]);
    if (n > cur && n <= cur + 3) {
      cur = n;
      out.push([a + m.index, `${n}. ${h[2].trim()}`]);
    }
  }
  return out;
}
export const noteTitle = (hs, pos) => hs.filter(([p]) => p < pos).at(-1)?.[1] ?? "";

/** 표 단위: 표 안 첫 단위 → 없으면 표 앞 텍스트의 마지막 단위(1,500자 → 8,000자 창) */
export function unitAt(x, tpos, tableHtml) {
  const inT = [...text(tableHtml).matchAll(UNIT)][0]?.[1];
  if (inT) return inT.replace(/\s/g, "");
  const pre = text(x.slice(Math.max(0, tpos - 20000), tpos)).slice(-8000);
  const us = [...pre.matchAll(UNIT)];
  return us.length ? us.at(-1)[1].replace(/\s/g, "") : null;
}

/** 표 앞 문맥(표 사이 문단의 마지막 문장) */
export function tableContext(x, a, tpos) {
  let win = x.slice(Math.max(a, tpos - 6000), tpos);
  const k = win.indexOf("</TABLE>");
  if (k >= 0 && !win.slice(0, k).includes("<TABLE")) win = win.slice(k + 8);
  win = win.replace(/<TABLE\b[\s\S]*?<\/TABLE>/gi, " ");
  const ps = [...win.matchAll(/<(?:P|SPAN)\b[^>]*>([\s\S]*?)<\/(?:P|SPAN)>/g)].map((m) => text(m[1])).filter((p) => p && !/^\(?\s*단위/.test(p));
  return ps.length ? ps.at(-1).slice(-300) : "";
}

/** 값 문자열 × 단위 → 원 단위 정수 문자열(소수가 남으면 null) */
export const toWon = (num, unit) => (num == null || UNIT_EXP[unit] == null ? null : scaleInt(num, UNIT_EXP[unit]));
