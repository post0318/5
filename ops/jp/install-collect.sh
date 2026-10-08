#!/usr/bin/env bash
# 일본 공시 원자료 매일 수집 타이머 설치(멱등) — scripts/jp/collect-daily.mjs(TDnet 결산단신 + J-Quants fins/summary 2년 창).
# 두 출처 모두 지난 자료가 사라지므로(TDnet 목록 약 31일, J-Quants 무료 창은 날마다 하루씩 밀림) 하루도 거르지 않게 Persistent=true.
#   sudo bash ops/jp/install-collect.sh
set -euo pipefail
cat >/etc/systemd/system/macro-jp-collect.service <<UNIT
[Unit]
Description=일본 공시 원자료 수집(TDnet 결산단신·J-Quants 결산 요약 → ~/jp-cache 디스크 + jp_* DB 색인)
After=network-online.target mongod.service
[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/5
ExecStart=/usr/bin/node scripts/jp/collect-daily.mjs --tdnet-days=7 --jq-from=auto
Nice=10
TimeoutStartSec=3h
UNIT
cat >/etc/systemd/system/macro-jp-collect.timer <<UNIT
[Unit]
Description=일본 공시 원자료 수집 매일 20:30 KST(TDnet 오후 공시 뒤) + 08:30(전날 밤 늦은 공시·J-Quants 창 이동분)
[Timer]
OnCalendar=*-*-* 20:30:00 Asia/Seoul
OnCalendar=*-*-* 08:30:00 Asia/Seoul
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now macro-jp-collect.timer
systemctl list-timers macro-jp-collect.timer --no-pager
