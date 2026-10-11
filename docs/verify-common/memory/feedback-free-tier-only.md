---
name: feedback-free-tier-only
description: "모든 인프라·외부 서비스는 무료 범위 안에서만 — 만들기 전 무료 한도 확인, 넘으면 하지 않는다(오너 \"무료 범위내다 확실하게 기억해라\")"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01d0db45-f81a-414b-9ed4-6a2233ab4a4a
  modified: 2026-10-04T05:07:17.607Z
---

오라클·구글·Vercel·MongoDB·외부 API 등 **모든 자원은 무료 범위 안에서만** 쓴다. 크레딧을 넘는 실제 지출은 0이어야 한다.

**Why:** 2026-10-04 오너 지시 "무료 범위내다 확실하게 기억해라"(오라클 2호기 생성 직후). 앞서 Claude 뉴스 판정 비용이 보고 없이 나가 오너가 크게 화냈고, 오라클·구글은 종량제라 한도를 넘으면 정지가 아니라 청구된다.

**How to apply:**
- 서버·디스크·IP·서비스를 새로 만들거나 크기를 바꾸기 **전에** 무료 한도 대비 합계를 계산해 보고한다. 현재 오라클 사용: 1호기 2코어·12GB + 2호기 1코어·8GB = 3코어·20GB, 디스크 94GB(한도 A1 4코어·24GB·디스크 200GB). 남은 여유 1코어·4GB·106GB.
- 한도를 넘거나 유료가 되는 선택지는 고르지 않는다(예: Cloud NAT·로드밸런서·유료 API). 필요하면 무료 대안을 찾고, 없으면 오너에게 비용과 함께 묻는다.
- 오라클 할당량 정책 `free-only`·예산 알림, 구글 지출 상한은 유지한다. 관련: [[project-hosting-no-billing]], [[feedback-report-costs-proactively]], [[feedback-news-llm-google-only]]
