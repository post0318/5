---
name: feedback-verify-server-memory
description: 2호기(1코어·8GB·스왑4GB)는 앱 서버 1개·검증기 동시 1개 — 2026-10-09 동시 작업으로 스왑 고갈·먹통
metadata:
  type: feedback
---
2호기에서 작업자를 여러 개 띄울 때 앱 서버는 기존 verify-dev(:3000) 하나만, 검증기·감사 시험은 동시에 1개만, 시작 전 `free -m` available 2GB 이상.

**Why:** 2026-10-09 작업자 3개 + 감사자들이 두 번째 next dev(:3093)·검증기 4개 병렬을 돌려 스왑 99.9% → 13:20 서버 먹통(OOM 킬 없이 스왑 스래싱이라 기록 없음), 정상 재시작도 안 먹어 15:03 강제 재부팅. 오너가 "진행상황 보고하면서 일해", 10분 넘게 침묵한 것 질책.
**How to apply:** 작업자 프롬프트에 위 규칙을 넣는다. 원인 조사는 `sar -r/-S -f /var/log/sysstat/saDD`. 기다리는 명령은 짧게 끊고 단계마다 보고. 재부팅(oci SOFTRESET/RESET)은 오너 확인 필요. 10-09 earlyoom 설치(mem≤5%·swap≤30% 이면 node/next 먼저 종료, mongod·python(IPO)·sshd 보호, 설정 /etc/default/earlyoom).

관련: [[feedback-dev-server-restart]] [[project-hosting-no-billing]]

**10-09 정비 결과(커널 값 확인)**: 2호기 CPU2·12GB(무료 한도 4·24 전부 사용: 1호기 2·12). 2호기 ubuntu=uid 1001 → user-1001.slice MemoryHigh 5.5G·Max 6G·Swap 1G, verify-dev High 2.5G·Max 3G, ipo@prod·dev MemoryMin 1G, swappiness 10(/etc/sysctl.d/90-macro-swap.conf), earlyoom. 1호기: macro-jobs.slice(High 3.5G·Max 4G)에 fin-/news-/research-/measure-/macro-/weekly-report 서비스(접두어 drop-in 50-jobs-slice.conf), 앱 컨테이너 3G·텔레그램 512M. 이 설정들은 저장소(ops/)에 아직 없음 — 서버 재구축 시 다시 넣어야 함.
