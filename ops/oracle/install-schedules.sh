#!/usr/bin/env bash
# GitHub 예약에서 옮겨 온 수집 작업의 systemd 타이머를 만든다(2026-10-04). 다시 돌려도 같은 결과(덮어씀).
# 빈도·근거는 docs/data-collection.md. 시각은 전부 KST. 분은 GitHub 시절 값을 그대로 써 사이트·작업끼리 겹치지 않게 했다.
# 사용: sudo bash install-schedules.sh
set -euo pipefail
U=/etc/systemd/system
unit() { # unit <이름> <설명> <실행> <OnCalendar 줄들(\n 구분)>
  local name="$1" desc="$2" exec="$3" cal="$4"
  printf '[Unit]\nDescription=%s\nAfter=docker.service\n[Service]\nType=oneshot\nExecStart=%s\nNice=10\nTimeoutStartSec=50min\n' "$desc" "$exec" > "$U/$name.service"
  { printf '[Unit]\nDescription=%s 예약\n[Timer]\n' "$desc"; printf '%b' "$cal" | while read -r c; do [ -n "$c" ] && echo "OnCalendar=$c Asia/Seoul"; done; printf 'Persistent=true\n[Install]\nWantedBy=timers.target\n'; } > "$U/$name.timer"
  echo "$name"
}
six() { local m="$1" out=""; for h in 08 10 12 14 16 18; do out+="*-*-* $h:$m:00\n"; done; printf '%s' "$out"; }

# ① 국내 리서치 — 하루 6회(첫 회 넓게, 나머지 최근 1일)
while read -r name min; do
  [ -z "$name" ] && continue
  unit "research-$name" "리서치(국내): $name" "/opt/macro/ops/run-research.sh collect-$name.mjs" "$(six "$min")"
done <<'LIST'
shinhan-research 00
sangsangin-research 02
sangsangin-industry-research 04
hana-research 10
nh-research 12
ibk-research 14
kiwoom-research 16
mirae-research 18
hanwha-research 20
samsung-research 22
yuanta-research 24
kb-research 26
daishin-research 28
im-research 30
meritz-research 35
kyobo-research 40
kis-research 45
hankyung-research 50
globalmonitor-research 55
ds-research 57
LIST

# ① 해외 IB·운용사 — 하루 1회
while read -r name hm; do
  [ -z "$name" ] && continue
  unit "research-$name" "리서치(해외 IB): $name" "/opt/macro/ops/run-script.sh collect-$name.mjs" "*-*-* $hm:00\n"
done <<'LIST'
blackrock-research 08:05
goldman-research 08:10
jpmorgan-research 08:15
morganstanley-research 08:20
pimco-research 08:25
bnpparibas-research 08:30
citigroup-research 08:35
boa-research 08:40
hsbc-research 08:45
dbresearch 08:52
LIST

# ② 거시경제 — Fed 금리 확률 일별 스냅샷(06:00)
unit macro-fedwatch-snapshot "거시경제: Fed 금리 확률 일별 스냅샷(Kalshi)" "/opt/macro/ops/call-cron.sh /api/cron/fedwatch 120" "*-*-* 06:00:00\n"
# ④ 종목분석 — StockAnalysis 개별 애널리스트 투자의견(하루 1회 10:20)
unit fin-analyst-forecasts "종목분석: StockAnalysis 애널리스트 투자의견" "/opt/macro/ops/run-script.sh collect-analyst-forecasts.mjs" "*-*-* 10:20:00\n"
# ③ 종목뉴스 미리 수집 — 10분마다 깨우고 종목별 신선도(한국 장중 10분·미국 장중 30분·장외 1시간)가 지난 것만 받는다(판정은 규칙, 비용 0)
unit news-stock-news "뉴스: 유니버스 종목뉴스 미리 수집" "/opt/macro/ops/call-cron.sh /api/cron/stock-news 290" "*-*-* *:00/10:00\n"
# ⑤ 주간 리포트 초안 — 월요일 06:00(오너 2026-10-03)
unit weekly-report "주간 리포트 초안 생성" "/opt/macro/ops/call-cron.sh /api/cron/weekly-report 330 '{\"force\":false}'" "Mon *-*-* 06:00:00\n"

# ④ 종목분석 — 한국 감가상각 적재(운영 kr_da, 증분 — 매일 05:50, 오너 결정 2026-10-05). 운영 kr_da 를 새 적재 규칙으로 쓰므로 **master 에 새 적재 코드가
#    병합·배포된 뒤에만** 설치한다 — 작업 폴더(/opt/macro/jobs)의 적재 스크립트에 규칙 판본(KR_DA_RULES_VERSION)이 없으면(옛 코드) 건너뛴다.
#    전체 처리(규칙 판본이 바뀐 배포 직후·--full)는 30종목 1시간 넘게 걸려 제한 시간을 4시간으로
if grep -q 'KR_DA_RULES_VERSION = "' /opt/macro/jobs/scripts/populate-kr-da.mjs 2>/dev/null; then
  install -m 755 /opt/macro/jobs/ops/oracle/run-kr-da.sh /opt/macro/ops/run-kr-da.sh
  printf '[Unit]
Description=종목분석: 한국 감가상각 적재(운영 kr_da, 증분)
After=docker.service
[Service]
Type=oneshot
ExecStart=/opt/macro/ops/run-kr-da.sh
Nice=10
TimeoutStartSec=4h
' > "$U/fin-kr-da.service"
  printf '[Unit]
Description=종목분석: 한국 감가상각 적재 예약
[Timer]
OnCalendar=*-*-* 05:50:00 Asia/Seoul
Persistent=true
[Install]
WantedBy=timers.target
' > "$U/fin-kr-da.timer"
  echo fin-kr-da
  KRDA=1
else
  echo "fin-kr-da 건너뜀 — 작업 폴더 적재 코드가 옛 판(규칙 판본 없음): master 병합·배포 뒤 다시 실행"
  KRDA=0
fi

systemctl daemon-reload
[ "$KRDA" = 1 ] && systemctl enable --now fin-kr-da.timer >/dev/null
for t in "$U"/research-*.timer "$U"/macro-fedwatch-snapshot.timer "$U"/fin-analyst-forecasts.timer "$U"/weekly-report.timer "$U"/news-stock-news.timer; do
  systemctl enable --now "$(basename "$t")" >/dev/null
done
systemctl list-timers --no-pager | grep -cE "research-|fedwatch-snapshot|analyst-forecasts|weekly-report|news-stock-news|fin-kr-da" | sed 's/^/타이머 수: /'
