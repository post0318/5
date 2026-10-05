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
daol-research 06
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
# ③ 인플루언서 네이버 블로그 새 글 — 5분마다 RSS 확인, 새 글만 DB(naver_blog_posts)에 저장(오너 2026-10-05, 오라클에서 직접 DB 쓰기 — 운영 앱 CPU 안 씀)
unit news-naver-blog "뉴스: 인플루언서 네이버 블로그 새 글 수집" "/opt/macro/ops/run-ts.sh naver-blog-poll.mts" "*-*-* *:00/5:00
"
sed -i 's/^TimeoutStartSec=.*/TimeoutStartSec=4min/' "$U/news-naver-blog.service" # 5분 주기라 멈춘 실행은 다음 회차 전에 정리
# ⑤ 주간 리포트 초안 — 월요일 06:00(오너 2026-10-03)
unit weekly-report "주간 리포트 초안 생성" "/opt/macro/ops/call-cron.sh /api/cron/weekly-report 330 '{\"force\":false}'" "Mon *-*-* 06:00:00\n"

systemctl daemon-reload
for t in "$U"/research-*.timer "$U"/macro-fedwatch-snapshot.timer "$U"/fin-analyst-forecasts.timer "$U"/weekly-report.timer "$U"/news-stock-news.timer "$U"/news-naver-blog.timer; do
  systemctl enable --now "$(basename "$t")" >/dev/null
done
systemctl list-timers --no-pager | grep -cE "research-|fedwatch-snapshot|analyst-forecasts|weekly-report|news-stock-news|news-naver-blog" | sed 's/^/타이머 수: /'
