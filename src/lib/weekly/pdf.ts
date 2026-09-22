import "server-only";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import type { WeeklyReportDoc } from "@/lib/db/weekly-reports";

/**
 * 주간 리포트 → PDF (오너 지시 2026-09-22 — "발행을 누르면 pdf로 생성하는 것
 * 반영하지 않았었나?"). 코드·문서·커밋 이력 어디에도 없어 신규 구현.
 *
 * **외부 API(PDFShift) 경유로 결정** — 처음엔 `@react-pdf/renderer`(순수 JS,
 * 헤드리스 브라우저 없음)로 가려 했으나, 그러면 발행된 markdown 본문(오너가
 * 편집기에서 직접 고친 최종본)을 PDF 전용 레이아웃으로 **다시 조립**해야
 * 했다 — 화면에 보이는 것과 달라질 위험이 있다. 오너 판단(월 발행 4~5건이면
 * PDFShift 무료 월 50건 안에 들어간다)으로 외부 API 로 전환. 화면에서 보던
 * markdown 을 같은 파서(remark + remark-gfm)로 HTML 로 바꿔 그 API 에
 * 넘기므로 "발행된 모습 그대로"가 보장된다. 헤드리스 브라우저를 우리
 * 함수에 안 올리므로 Vercel Functions Storage 영향도 없다(2026-09-22
 * 세션에서 겪은 문제와 정반대 방향).
 *
 * **react-dom/server 대신 remark→rehype 파이프라인을 쓴다** — Next.js App
 * Router 가 Route Handler(서버 전용 모듈)에서 `react-dom/server` 를 import
 * 하는 것 자체를 빌드 에러로 막는다("You're importing a component that
 * imports react-dom/server", 실측 2026-09-22). 화면의 `react-markdown` 도
 * 내부적으로 이 remark 파서를 쓰므로 파싱 결과(어떤 걸 표·볼드·리스트로
 * 인식하는지)는 동일하고, 마지막 단계만 React 엘리먼트 대신 HTML 문자열로
 * 직렬화(`rehype-stringify`)한다.
 *
 * PDFShift 계정·API 키는 오너가 직접 발급(가입 필요 — 이 저장소 코드는
 * PDFSHIFT_API_KEY 를 읽기만 한다). 미설정 시 503 으로 조용히 막는다
 * (CRON_SECRET·GEMINI_API_KEY 와 같은 패턴, route.ts 참고).
 */

const PDFSHIFT_ENDPOINT = "https://api.pdfshift.io/v3/convert/pdf";

export function isPdfExportConfigured(): boolean {
  return Boolean(process.env.PDFSHIFT_API_KEY);
}

/**
 * 발행 화면과 **같은 파서**(remark + remark-gfm)로 markdown 본문을 HTML
 * 문자열로 만든다 — 별도 PDF 레이아웃을 새로 짜지 않고 화면에 보이는
 * 표·서식을 그대로 재현하기 위해서다.
 *
 * 색상은 앱의 다크/라이트 테마 변수(`var(--border)` 등)에 기대지 않고
 * 인쇄용 고정값을 쓴다 — PDFShift 는 이 HTML 을 독립된 문서로 렌더링하므로
 * 앱의 `:root` 변수 정의가 없고, PDF 는 어차피 라이트 배경으로 인쇄·열람되는
 * 게 자연스럽다.
 */
async function renderReportHtml(doc: WeeklyReportDoc): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(doc.body);
  const bodyHtml = String(file);
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
    font-size: 11px;
    line-height: 1.55;
    color: #1a1a1a;
    margin: 0;
    padding: 24px;
  }
  h1 { font-size: 18px; font-weight: 700; margin: 0 0 12px; }
  h2 { font-size: 15px; font-weight: 600; margin: 18px 0 6px; border-bottom: 1px solid #d0d0d0; padding-bottom: 3px; }
  h3 { font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  p { margin: 5px 0; }
  ul, ol { margin: 4px 0 8px; padding-left: 18px; }
  li { margin: 2px 0; }
  strong { font-weight: 600; }
  em { font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; page-break-inside: avoid; }
  th, td { border: 1px solid #d0d0d0; padding: 3px 8px; text-align: left; font-size: 10.5px; }
  th { background: #f0f0f0; font-weight: 600; }
  a { color: #1a56db; text-decoration: underline; }
  hr { border: none; border-top: 1px solid #d0d0d0; margin: 12px 0; }
</style>
</head>
<body>
<h1>${escapeHtml(doc.title)}</h1>
${bodyHtml}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** PDFShift 응답이 성공이어도 4xx/5xx 를 던지지 않는 경우가 있어(문서 확인)
 *  Content-Type 으로 실패를 가른다 — JSON 이 오면 에러 메시지가 담겨있다. */
export async function generateWeeklyReportPdf(doc: WeeklyReportDoc): Promise<Buffer> {
  const key = process.env.PDFSHIFT_API_KEY;
  if (!key) throw new Error("PDFSHIFT_API_KEY 미설정");

  const html = await renderReportHtml(doc);
  const res = await fetch(PDFSHIFT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
    },
    body: JSON.stringify({
      source: html,
      format: "A4",
      margin: "16mm 14mm",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || contentType.includes("application/json")) {
    const detail = await res.text().catch(() => "");
    throw new Error(`PDFShift 변환 실패 (${res.status}): ${detail.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
