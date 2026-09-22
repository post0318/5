import "server-only";

/**
 * 종목뉴스 LLM 월 과금 상한 초과 알림 — Resend REST API(SDK 없이 fetch 직접 호출,
 * 신규 의존성 최소화). RESEND_API_KEY/ALERT_EMAIL_TO 미설정이면 조용히 스킵
 * (앱 내 에러 팝업은 별도로 항상 뜸 — 이메일은 부가 알림).
 */
export async function sendBudgetAlert(month: string, totalCostUsd: number): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  if (!apiKey || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "종목뉴스 알림 <onboarding@resend.dev>",
        to: [to],
        subject: `[종목뉴스] ${month} LLM 월 과금 상한 도달`,
        html: `<p>${month} 종목뉴스 번역·요약 누적 비용이 $${totalCostUsd.toFixed(
          2,
        )}로 월 상한에 도달해 이번 달 남은 기간 호출이 중단됩니다.</p>`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // 이메일 실패해도 앱 동작(상한 차단)엔 영향 없음 — 조용히 무시
  }
}

/**
 * 주간 리포트 발행 메일 — 발행 버튼 한 번에 PDF 생성과 함께 메일도 나간다
 * (오너 지시 2026-09-18, 별도 버튼은 두지 않음).
 *
 * 본문 HTML 은 PDF 와 **같은 파서**(`weeklyMarkdownToHtml`)로 만든다 — 발행된
 * 모습과 메일 내용이 어긋나지 않게 하려고. 다만 Gmail 등이 <style> 블록을
 * 떼는 경우가 있어 표·제목처럼 서식이 무너지면 못 읽는 요소만 인라인 스타일로
 * 다시 박는다.
 *
 * 키나 수신 주소가 없으면 보내지 않고 이유만 돌려준다 — 발행 자체는 성공으로
 * 두고(메일은 부가 기능) 호출부가 화면 메시지에 반영한다.
 */
export async function sendWeeklyReportEmail(doc: {
  title: string;
  weekStart: string;
  weekEnd: string;
  body: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.WEEKLY_EMAIL_TO || process.env.ALERT_EMAIL_TO;
  if (!apiKey) return { sent: false, reason: "RESEND_API_KEY 미설정" };
  if (!to) return { sent: false, reason: "WEEKLY_EMAIL_TO/ALERT_EMAIL_TO 미설정" };

  const { weeklyMarkdownToHtml } = await import("@/lib/weekly/pdf");
  const html = inlineStyles(await weeklyMarkdownToHtml(doc.body));

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "주간 리포트 <onboarding@resend.dev>",
        to: to
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        subject: `[주간 리포트] ${doc.weekStart} ~ ${doc.weekEnd}`,
        html: `<div style="${WRAP}">${html}</div>`,
        // HTML 을 막아둔 환경에서도 읽히게 markdown 원문을 같이 싣는다
        text: doc.body,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { sent: false, reason: `Resend ${res.status} ${t.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "전송 실패" };
  }
}

const WRAP =
  "font-family:-apple-system,'Segoe UI','Malgun Gothic',sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:760px";
const TABLE = "border-collapse:collapse;width:100%;margin:8px 0 12px";
// text-align 은 일부러 넣지 않는다 — GFM 열 정렬이 `align` 속성으로 나오는데
// 인라인 style 에 text-align 을 박으면 그 속성이 무시돼 스냅샷 표의 숫자 열이
// 왼쪽으로 돌아가 버린다.
const CELL = "border:1px solid #d0d0d0;padding:4px 8px";
const TH = `${CELL};background:#f3f4f6;font-weight:600`;

/** 여는 태그를 속성 유무와 상관없이 한 번에 처리한다 — `<td>` 와 `<td ` 를
 * 따로 치환하면 앞 치환이 만든 `<td style=...` 를 뒤 치환이 또 잡아 style 이
 * 두 번 붙는다. 공백은 `\s` 대신 리터럴 한 칸을 쓴다(템플릿 리터럴 안의
 * `\s` 는 이스케이프로 먹혀 그냥 `s` 가 된다 — 실측으로 정렬된 셀이 치환에서
 * 통째로 빠지는 버그가 났다). */
function styleTag(html: string, tag: string, style: string): string {
  return html.replace(
    new RegExp(`<${tag}( [^>]*)?>`, "g"),
    (_m, attrs: string | undefined) => `<${tag} style="${style}"${attrs ?? ""}>`,
  );
}

function inlineStyles(html: string): string {
  let out = html;
  out = styleTag(out, "table", TABLE);
  out = styleTag(out, "th", TH);
  out = styleTag(out, "td", CELL);
  out = styleTag(out, "h1", "font-size:19px;margin:0 0 12px");
  out = styleTag(
    out,
    "h2",
    "font-size:16px;margin:18px 0 6px;border-bottom:1px solid #e5e7eb;padding-bottom:3px",
  );
  out = styleTag(out, "h3", "font-size:15px;margin:12px 0 4px");
  return out;
}
