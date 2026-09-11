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
