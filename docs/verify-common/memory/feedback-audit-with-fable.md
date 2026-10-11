---
name: feedback-audit-with-fable
description: "감사 모델 — 반복 재검증·감사는 Opus, 지표 닫을 때 최종 점검 1회만 Fable (2026-09-26 오너 변경)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0bf0a7e0-1695-4c81-80a5-b89200950463
  modified: 2026-09-26T01:03:54.767Z
---

**반복 재검증·감사(지적 → 수정 → 재확인 루프)는 model: "opus"**, 지표를 닫을 때 **최종 점검 한 번만 model: "fable"**.

**Why:** 오너 2026-09-26 — "재검증과 감사를 파블에서 오퍼스로 바꾼다. 너무 많이 먹는다… 최종 점검할때 파블로 한번 사용하는게 맞을 것 같다. 반복재검증 감사를 파블로 하니 어제와 같은 사태가 발생한다." 매출 하나에 Fable 감사 4회를 돌려 주간 사용량이 97%까지 찼다. (이전 규칙 2026-09-25 "감사는 전부 Fable" 은 폐기.)

**How to apply:** 감사 에이전트 호출 시 반복 단계는 opus, 최종 승인 단계만 fable. 최종 점검에서 수정 요청이 나오면 수정 확인은 다시 opus. 관련: [[feedback-usage-waste]], [[feedback-batch-fix-then-verify]]
