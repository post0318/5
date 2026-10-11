---
name: feedback-check-before-report
description: 보고·선택지는 먼저 확인을 끝낸 사실로만 — 오너가 물어본 뒤에야 확인하지 말 것
metadata:
  type: feedback
---
보고나 선택지(AskUserQuestion)에는 이미 확인한 사실만 넣는다. 확인 안 된 안(案)을 넣고 오너가 물으면 그제서야 확인하는 방식 금지.

**Why:** 2026-10-09 2호기 확장안에 디스크 확장을 근거 없이 넣었다가 "디스크도 부족한가?"에 그제서야 du 로 확인 — 오너 "물어보면 그때 확인하지마. 보고는 먼저 확인하고 이야기하는거다".
**How to apply:** 보고 전에 관련 수치(사용량·잔여·원인)를 모두 확인하고, 각 선택지는 필요성이 확인된 것만. 긴 대기 중에도 단계마다 짧게 보고.

관련: [[feedback-no-false-assurance]] [[feedback-verify-server-memory]]
