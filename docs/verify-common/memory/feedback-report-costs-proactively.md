---
name: feedback-report-costs-proactively
description: 돈이 나가는 것(유료 API·클라우드)은 발견 즉시·정기적으로 먼저 보고 — 오너가 모르는 과금이 있으면 안 된다
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01d0db45-f81a-414b-9ed4-6a2233ab4a4a
  modified: 2026-10-03T12:57:01.813Z
---

유료 호출·클라우드 과금은 오너가 묻기 전에 먼저 보고한다. 새 기능이 유료 API 를 부르면 만들 때 예상 비용(호출 빈도 × 건당 비용)을 보고하고, 운영 중인 비용은 정기 보고·한도 알림이 실제로 오너에게 도착하는지 확인한다.

**Why:** 2026-10-03 오너 "지금 제일 문제는 이 문제를 너는 나에게 처음으로 보고 했다. 나는 전혀 인지를 못하고 있었다." — 종목뉴스 미리 수집이 Claude 를 하루 330번 불러 9월·10월 월 상한(10달러)을 채우고 있었는데, 한도 알림 메일(llm_usage.alertSentAt)은 RESEND_API_KEY 미설정으로 한 번도 발송되지 않았고 아무도 보고하지 않았다.

**How to apply:** 작업 시작·마무리 때 유료 사용처를 점검해 숫자로 보고한다. 알림·보고 장치는 "만들었다"가 아니라 "실제로 도착했다"를 확인해야 끝난 것이다(조용히 건너뛰는 알림은 없는 것과 같다). 관련: [[feedback-news-llm-google-only]], [[project-hosting-no-billing]], [[feedback-no-false-assurance]]
