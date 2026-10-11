---
name: project-hosting-no-billing
description: "2026-10 호스팅 구성 — 오라클 메인·구글/Vercel 보조, 오라클·구글은 과금 0 이 최우선이며 통제 장치를 유지한다"
metadata:
  node_type: memory
  type: project
  originSessionId: 01d0db45-f81a-414b-9ed4-6a2233ab4a4a
  modified: 2026-10-04T02:19:35.990Z
---

2026-10-03 오너 결정: **오라클(macro-insights.duckdns.org, 오사카 ARM 2코어·12GB, 161.33.9.115) 메인**, 구글 Cloud Run(brave-smile-508510-g5, asia-northeast1)과 Vercel 은 보조로 같이 쓴다. 무거운 자동 작업(ttm-build·fin-build·수집 전송)은 오라클로 보낸다.

**오라클·구글은 과금이 생기지 않게 하는 것이 매우 중요하고, 이를 통제한다**(오너 지시). 오라클·구글 모두 결제 수단이 연결된 종량제라 한도를 넘으면 실제로 청구된다.

**Why:** Vercel Hobby 가 Active CPU 한도 초과로 정지된 직후 이전한 것 — 같은 사용 패턴이 오라클·구글에서는 정지가 아니라 청구로 이어진다.

**How to apply:** 자원을 새로 만들거나 설정을 바꿀 때마다 무료 한도 안인지 먼저 확인하고 보고한다. 오라클은 할당량 정책 `free-only`(A1 4코어·24GB, 디스크 200GB 외 차단)와 1달러 예산 알림을 유지하고, 정책을 임시로 풀면 즉시 되돌린다. 구글은 Cloud Run 최대 인스턴스·이미지 저장소 정리·예산 통제를 유지하고 무거운 작업을 보내지 않는다. 관련: [[project-vercel-cpu-limit]]

**예약 작업 위치(2026-10-04 기준, 상세는 docs/data-collection.md·DEPLOY.md §0)**: GitHub 예약 0 — 전부 오라클 1호기 타이머(리서치 30·종목뉴스 10분·fin/ttm·주간 리포트 등 40개, `ops/oracle/install-schedules.sh`). 사무실 PC 작업 스케줄러 — macro-research-bnk(BNK 해외 IP 차단, 창 없이 wscript 로 실행).

**오라클 2호기 `macro-verify`(2026-10-04, 1코어·8GB, 140.83.48.57)**: 재무 검증 전용 — kr/verification 개발 서버(localhost:3000, 외부 비공개). DART·SEC 요청 제한이 운영 IP 에 번지지 않게 분리(오너 승인, 아이디·키는 1호기와 같은 것 — "아이디 관리 복잡해지는 건 싫다"). 두 대 합계 3코어·20GB(무료 한도 이내). 재무 검증은 이 PC 대신 2호기에서 돌린다(PC 메모리 부족).

**2026-10-05 구성 확정(오너)**: 1호기 = 운영(1순위 주소 macro-insights.duckdns.org, 바뀌지 않음), 2호기 = 검증 + IPO 운영(보안 격리 — IPO 를 1호기로 옮기지 않음), Vercel = 2순위 주소(402 해제 후 재연동), 구글 Cloud Run = 종료(서비스 삭제·배포 워크플로 비활성, 이미지 208MB 보존). 빌드는 GitHub 기반. 상태 점검은 1·2호기 상호 감시. **SSH 키 서버별 분리**: 1호기 `~/.ssh/oracle_macro`(별칭 macro-prod), 2호기 `~/.ssh/oracle_verify`(별칭 macro-verify) — 2호기에서 oracle_macro 제거(백업 authorized_keys.bak-20261005). rpcbind(111) 두 서버 모두 끔.
**2호기 역할 최종(오너 2026-10-05)**: "2호기에 백업은 하지 않고 개발·검증만 간다. 원래 취지도 그게 맞다." — 운영 앱 대기 백업 없음, 2호기 = 개발·검증(+ 이미 있던 IPO 운영). 2호기 MongoDB 매일 복사(05:30)는 백업이 아니라 검증용 데이터 공급 목적. → 정정(같은 날): "DB 백업은 구성하고 앱 백업은 하지 않는다", "설정 백업 보관소도 2호기에 추가한다". 2호기 = 개발·검증 + DB 백업(매일 7·주간 4주·월간 3개월, 복원 시험 통과) + 1호기 설정 백업(1호기에서 암호화, 복호화 키는 1호기·이 PC 의 macro-config-backup.key). 앱 대기 백업은 없음.
**2호기 커널 고정(2026-10-05)**: 커널 7.0 업데이트 후 MongoDB 8.0.32 가 기동 거부(SERVER-121912, 커널 6.19+ 비호환, 수정판 없음) → GRUB_DEFAULT 를 6.17.0-1020-oracle 로 고정. MongoDB 8.0.33 이상 등 수정판이 나오면 업그레이드 후 고정 해제.
