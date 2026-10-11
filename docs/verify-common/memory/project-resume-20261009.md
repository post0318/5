---
name: project-resume-20261009
description: 2026-10-09 오후 PC 종료 시점 재개 지점 — 한국 6차 재감사 대기, 미국 검증불가 정리, 일본 EV·검증기·한국어화, 오너 결정 반영분
metadata:
  type: project
---

**PC 를 끄면 이 세션의 작업자(로컬 에이전트)는 멈춘다** — 재개 시 아래 브랜치·서버 상태부터 확인(git log, 2호기 `git -C ~/5 status`, `~/5-jp`).

**운영 반영 완료(10-09)**: master 에 usage-ledger·universe-precompute·BlackRock 수정·미국 앱 수정 8f726f3(→80b3eb4)·민카부 카드(→fb9b03d) 배포. 감시 제외 5곳(freshness-ignore), 한경컨센서스 라벨 55건 삭제, 1호기 docker 정리(29%). 4번: 실시간 호가 우선·차트 기간·눈금·세로 자동·시뮬 매도 기본값. 2번 브라질 검색창은 이미 없었음.

**진행 중(재개 시 이어서)**:
- 한국: 4차 감사 지적 수정 e8cc6d4 → 5차 REVISE(PER·PBR·PSR 값 자체 미대조 MAJOR, daCfLine 부분합, na-up 항목 단위). kr-fix4 가 수정 중이었음(2호기 ~/5, kr/verification, 미커밋 가능) → 끝나면 6차 재감사 → 승인 시 master 병합 체크리스트(CLAUDE.md 한국 작업 운영 규칙). 012450 은 DART XBRL 점검(status 800), 2호기 ~/retry-012450.sh 가 자동 재시도.
- 미국 검증불가 32: E층 4·AVGO 정리, 앱 결함 7건 수정 지시(WMT 이연법인세 혼합, META·DAL 분기 칸 오표시, GEV·VRT 잔여 줄, BE 주식보상 고유 태그) + 오너 결정 IBM 2021 감가상각 = 빈칸+사유, DAL CAPEX = 항공기+기타 두 줄 합. TSM 블룸버그 검증불가 유지. 같은 ~/5 에서 us-na-close 작업(자기 파일만 add).
- 일본: jp/verification(2호기 ~/5-jp, b7f8a2e) 검증기 1차(10종 실패 0). 오너 결정 D1~D11 "권고안대로": FY=결산일 연도, 도요타·소니 금융사업 EV=부문 차입금 있으면 CAT 방식, SBG 하이브리드 본표 그대로, MHI 차입금 분리 근거 없으면 공란, 키옥시아 추정 기간 맞을 때만, 손상 원칙 동일, 검증용 EDINET 키 분리, 소니 FY2022 한 서류 기준. **EV 빈칸 우선순위 1**: 혼다·히타치·다케다 전 기간 "리스부채 확인 불가" → 有報 XBRL 주석 리스부채로(한국 krLeaseFor 원칙). 운영 반영은 리드가.
- 일본 화면 한국어화: jp-korean, worktree C:\Users\post0\5-jpko 브랜치 fix/jp-korean-labels(master 기준) — 확인 후 master 반영 예정.

관련: [[feedback-do-it-yourself]] [[project-verification-order]]

**10-09 재개(같은 날 저녁)**: 2호기 미커밋분 백업 → origin `wip/uncommitted-5-20261009`(~/5, 한국+미국 섞임)·`wip/uncommitted-5jp-20261009`(~/5-jp). 작업자 재기동: kr-fix5(5차 지적 수정→6차 재감사), us-close(미국 앱 결함 7건+오너 결정 2건), jp-ev(혼다·히타치·다케다 리스부채→EV, 검증기 확장). jp-korean 550991f 오너 승인 후 master 배포 완료(운영 7203 재무제표 27줄 전부 한글 확인).

**10-09 저녁~10-10 운영 배포**: 579b7cf(DART 키 가림)·47ba7f6(미국 898c0cd·20da1b1, ENGINE 46, fin-build 51종목 1,479초)·21ea0ba(옛 판 저장본 유지·fin_view/ttm_chg 변경 기록·post-deploy 순서 — deploy/snap-stale 로 master 기준 이식, 검증 우회·한국 감사 코드 제외). 2호기 확장 CPU2·12GB + 메모리 정비([[feedback-verify-server-memory]]). 진행 중: 한국 9차 감사, 일본 42종목 재검증(메모리 해제 수정판).
