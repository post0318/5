---
name: feedback-news-llm-google-only
description: "종목뉴스에 Claude(Anthropic) LLM 금지 — LLM 이 필요하면 구글 Gemini API 만, 그리고 사용과 무관하게 돌며 유료 호출하는 구조 금지"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01d0db45-f81a-414b-9ed4-6a2233ab4a4a
  modified: 2026-10-03T12:55:20.590Z
---

종목뉴스(관련성 판정·중복 묶기·제목 번역 폴백·기사 요약)에 Claude/Anthropic 을 쓰지 않는다. LLM 이 필요하면 구글 Gemini API 만 허용(구글 크레딧 + 지출 상한 guard-gemini 13,000원 안).

**Why:** 2026-10-03 오너 지시 "종목뉴스에 llm으로 에이전트 사용을 금지한다. llm으로 사용시 구글 api만 허용한다". 직전에 30분마다 도는 종목뉴스 미리 수집이 같은 기사 72건을 매번 Claude Haiku 로 다시 판정해 아무도 안 보는데 하루 약 2.5달러(월 상한 10달러를 3~4일에 소진)가 나간 것이 드러남 — 오너 "장난하는 것도 아니고... 하는 것도 없이 비용이 나간다고?".

**How to apply:** 뉴스 쪽 LLM 호출은 lib/weekly/gemini.ts 계열(Gemini)로만. 예약·자동 작업이 유료 API 를 부를 때는 판정 결과를 저장해 새 항목만 보내는 등 "사용량 = 새 데이터 양"이 되게 설계하고, 사용과 무관하게 반복 과금되는 구조는 만들지 않는다. 관련: [[project-hosting-no-billing]]
