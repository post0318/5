#!/usr/bin/env python3
"""4번(브라질) 뉴스 감시 — 원본에는 새 글이 있는데 4번 화면에 없을 때만 실패(오너 지시 2026-10-17 "그래").

4번은 원본 조회가 실패해도 보관함(7일)의 옛 기사를 그대로 보여 줘서, 매체가 쉬는 날과 4번이 못 받아 온 날이
화면에서 똑같다. 그래서 원본을 직접 보고 비교한다. healthcheck.sh 가 1시간에 한 번 부르고, 줄마다
"키<TAB>정상(1/0)<TAB>메시지" 를 낸다. 4번 화면 캐시(뉴스 30분)·발행 지연을 감안해 원본 글이 3시간 넘게
지났는데도 4번에 없을 때만 실패로 본다.

거르기 규칙은 4번 코드를 옮겨 왔다 — 4번에서 바꾸면 여기도 맞출 것:
  좋은아침뉴스 RELEVANT·FEED_PAGES = 4번 src/lib/server/bomDiaNews.ts
  KOBRAS 카테고리·제목 = 4번 src/lib/server/kobrasDailyReport.ts
  글로벌 검색어 = 4번 src/lib/server/brazilNews.ts GLOBAL_QUERY
"""
import json, os, re, sys, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

sys.stdout.reconfigure(encoding="utf-8")
APP = sys.argv[1] if len(sys.argv) > 1 else "https://brazil-world.vercel.app"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
NOW = datetime.now(timezone.utc)
LAG = timedelta(hours=3)

RELEVANT = re.compile(r"금리|기준금리|Selic|셀릭|Copom|코팜|헤알|환율|외환|국채|채권|국가?부채|공공부채|재정|적자|흑자|세제|세금|조세|증세|감세|IBS|CBS|심플레스|물가|인플레|디플레|중앙은행|통화정책|증시|주가|Ibovespa|보베스파|경제성장|경기|GDP|성장률|실업|고용|일자리|인건비|임금|노동개혁|6\s*[×xX]\s*1|소비자\s*신뢰|소비심리|소비자신뢰지수|소비지출|민간소비|소매판매|산업생산|기업신뢰|경기신뢰|FGV|무역|교역|수출|수입|관세|외국인\s*투자|신용등급|국가\s*신용|S&P|피치|무디스|Fitch|Moody|룰라\s*정부|하원|상원|연방대법원|STF|대선|탄핵|재정개혁|연금개혁|세제개편|예산안|Petrobras|페트로브라스|Vale|철광석|유가|국제유가|경제부|재무부", re.I)
GLOBAL_QUERY = 'Brazil (economy OR politics OR markets OR "central bank" OR Selic OR real OR election OR inflation OR fiscal OR budget)'


def get(url, timeout=30):
    headers = {"User-Agent": UA}
    # 4번은 사내 한정(로그인 필수, 2026-10-27) — 4번 주소에만 점검 토큰을 붙인다(원본 사이트로 새지 않게)
    if url.startswith(APP + "/") and os.environ.get("OPS_BR_TOKEN"):
        headers["X-Ops-Token"] = os.environ["OPS_BR_TOKEN"]
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def items(xml):
    return re.findall(r"<item>([\s\S]*?)</item>", xml, re.I)


def tag(name, block):
    m = re.search(rf"<{name}[^>]*>([\s\S]*?)</{name}>", block, re.I)
    if not m:
        return ""
    v = m.group(1).strip()
    c = re.match(r"<!\[CDATA\[([\s\S]*?)\]\]>$", v)
    return c.group(1).strip() if c else v


def pub(block):
    try:
        return parsedate_to_datetime(tag("pubDate", block)).astimezone(timezone.utc)
    except Exception:
        return None


def iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def fmt(d):
    return (d + timedelta(hours=9)).strftime("%m-%d %H:%M KST") if d else "없음"


def out(key, ok, msg):
    print(f"{key}\t{1 if ok else 0}\t{msg}")


# 4번 화면 응답
try:
    news = json.loads(get(f"{APP}/api/br-news", 60))
except Exception as e:
    news = None
    out("br-news-app", False, f"4번 뉴스 응답 실패({type(e).__name__}) — {APP}/api/br-news")
if news is not None:
    out("br-news-app", True, "")

# 1) 좋은아침뉴스(현지 뉴스)
if news is not None:
    try:
        blocks = []
        for p in range(1, 4):
            u = "https://bomdianews.com.br/category/brazilnews/feed/" + ("" if p == 1 else f"?paged={p}")
            try:
                blocks += items(get(u))
            except Exception:
                if p == 1:
                    raise
        src = [d for b in blocks
               if (RELEVANT.search(tag("title", b)) or RELEVANT.search(tag("description", b)))
               and (d := pub(b)) and NOW - timedelta(days=7) < d < NOW - LAG]
        app = [d for x in news.get("items", []) if (d := iso(x.get("publishedAt")))]
        s_new, a_new = max(src, default=None), max(app, default=None)
        ok = s_new is None or (a_new is not None and a_new >= s_new - timedelta(minutes=1))
        out("br-news-local", ok, f"4번 현지 뉴스(좋은아침뉴스)가 원본보다 뒤처짐 — 원본 최신 {fmt(s_new)}, 4번 최신 {fmt(a_new)}(4번 bomDiaNews.ts 조회 확인)")
    except Exception as e:
        print(f"[br-news] 좋은아침뉴스 원본 확인 실패 {type(e).__name__} — 판정 보류", file=sys.stderr)

# 2) 글로벌 뉴스 — 4번은 관련성 순 상위만 골라 원본과 1:1 비교가 안 된다. 원본에 24시간 안 기사가 3건 이상인데
#    4번 최신 글로벌 기사가 36시간 넘게 지났으면 실패.
if news is not None:
    try:
        u = "https://news.google.com/rss/search?q=" + urllib.parse.quote(GLOBAL_QUERY) + "&hl=en-US&gl=US&ceid=US:en"
        fresh = [d for b in items(get(u)) if (d := pub(b)) and d > NOW - timedelta(hours=24)]
        app = [d for x in news.get("global", []) if (d := iso(x.get("publishedAt")))]
        a_new = max(app, default=None)
        ok = len(fresh) < 3 or (a_new is not None and a_new > NOW - timedelta(hours=36))
        out("br-news-global", ok, f"4번 글로벌 뉴스가 멈춤 — 4번 최신 {fmt(a_new)}, 원본 24시간 안 {len(fresh)}건(4번 brazilNews.ts·번역 확인)")
    except Exception as e:
        print(f"[br-news] 구글 뉴스 원본 확인 실패 {type(e).__name__} — 판정 보류", file=sys.stderr)

# 3) KOBRAS 브라질 데일리 리포트
try:
    rep = json.loads(get(f"{APP}/api/br-daily-report", 60)).get("report") or {}
except Exception as e:
    rep = None
    out("br-news-kobras", False, f"4번 데일리 리포트 응답 실패({type(e).__name__}) — {APP}/api/br-daily-report")
try:
    if rep is None:
        raise StopIteration
    xml = get("https://rss.blog.naver.com/dari0202.xml")
    src = [d for b in items(xml)
           if "브라질정보자료" in tag("category", b) and re.search(r"데일리\s*리포트", tag("title", b))
           and (d := pub(b)) and d < NOW - LAG]
    s_new, a_new = max(src, default=None), iso(rep.get("publishedAt"))
    ok = s_new is None or (a_new is not None and a_new >= s_new - timedelta(minutes=1))
    out("br-news-kobras", ok, f"4번 브라질 데일리 리포트가 원본보다 뒤처짐 — 원본 최신 {fmt(s_new)}, 4번 {fmt(a_new)}(4번 kobrasDailyReport.ts 확인)")
except StopIteration:
    pass
except Exception as e:
    print(f"[br-news] KOBRAS 확인 실패 {type(e).__name__} — 판정 보류", file=sys.stderr)
