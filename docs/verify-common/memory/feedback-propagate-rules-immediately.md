---
name: feedback-propagate-rules-immediately
description: 오너 지적은 메모리에만 두지 말고 그 자리에서 CLAUDE.md "작업 규칙" 절에 반영 — 작업자는 메모리를 못 본다
metadata:
  type: feedback
---
오너가 지적·지시하면 **그 자리에서** CLAUDE.md "작업 규칙 (오너 지시 모음)" 절에 한 줄로 반영하고, 작업자 지시문에도 넣는다. 메모리에만 적고 "다음에 반영" 금지.

**Why:** 2026-10-10 오너 "같은 실수·같은 오류·같은 지적 반복", "이제서야 md 반영하고 지시문 전달하겠다는 건 이해가 안 된다", "이렇게 소비하는 사용량은 너가 물어줄 것인가". 원인: 지적을 메모리에만 저장(사례로 좁게) → 코드를 짜는 작업자는 메모리를 못 봐서 같은 실수 반복(DART 반복 조회 — 10-03 "새로 나온 것만" 지시 위반).
**How to apply:** 지적 받으면 ① CLAUDE.md 작업 규칙 절 갱신(일반 원칙으로) ② 진행 중 작업자에게 즉시 전달 ③ 기존 코드에 같은 위반이 있는지 확인. 2026-10-10 절 신설(kr-fix11 커밋, kr/verification) — master 병합 시 함께.

관련: [[feedback-process-only-new]] [[feedback-usage-waste]]
