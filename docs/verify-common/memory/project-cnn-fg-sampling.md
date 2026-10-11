---
name: project-cnn-fg-sampling
description: "오라클 1회성 실측 4건(10-05~07) — CNN 갱신 주기·다음 선물 게시 시각·KRX 10-06분 공개 시각, 10-07 07:00 KST 자동 보고서"
metadata:
  node_type: memory
  type: project
  originSessionId: 01d0db45-f81a-414b-9ed4-6a2233ab4a4a
  modified: 2026-10-04T06:15:29.198Z
---

2026-10-03 오너 지시("실측예약한다", "예약해두고 보고서 처리"). 처음엔 systemd-run 임시 타이머로 걸었는데 **10-04 보안 업데이트 재부팅으로 전부 사라져**(재부팅하면 없어지는 방식), 10-04 에 정식 systemd 유닛으로 다시 걸었다(오라클 1호기 161.33.9.115, `/etc/systemd/system/measure-*`):

- `measure-cnn`: 10-05 22:20 KST 시작 ~ 10-06 05:30 KST(스크립트가 끝 시각에 멈춤), 5분마다 → `/opt/macro/ops/cnn-sample.log`
- `measure-daum`: 10-05 16:30·18:40·21:00 KST 다음 금융 외국인 선물 최신일 → `/opt/macro/ops/daum-fut-check.log`
- `measure-krx`: 10-06 15:40·16:30·17:30·18:30·19:30·21:00, 10-07 06:00 KST — KRX OPEN API 10-06 거래분 종목 수 → `/opt/macro/ops/krx-publish-check.log`
- `measure-report`: 10-07 07:00 KST — CNN·KRX 로그로 `/opt/macro/ops/measure-report-20261007.md`(GitHub 이슈 라벨 `ops-report` 로도). 다음 선물은 보고서에 안 들어가니 daum 로그를 직접 읽는다.

**Why:** CNN 캐시 단축 여부, KRX·다음 선물 수집 시각(지금 다음 날 06:30)을 당일 저녁으로 당길 수 있는지 판단 근거.

**How to apply:** 10-07 07:00 이후 대화를 열면 보고서와 daum 로그를 읽어 결과·제안을 보고하고 결정을 받는다. 끝나면 `measure-*` 유닛 4개를 지운다(1회성). 재부팅이 필요하면 측정 기간(10-05 16:00 ~ 10-07 07:00)은 피한다. CNN 캐시 `src/lib/macro/feargreed.ts`, 다음 선물 `scripts/collect-foreign-fut.mjs`. 관련: [[project-hosting-no-billing]]
