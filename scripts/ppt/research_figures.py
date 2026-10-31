#!/usr/bin/env python3
"""증권사 리포트 PDF 한 개에서 그림·표 후보를 잘라낸다(research-figures.mts 가 부름).

방법(poppler 만 사용): `pdftotext -bbox-layout` 로 줄 좌표를 읽어
  위 = 캡션 줄(「그림 1.」「표 2」「도표 3」「Figure 4」「Exhibit 5」 …), 아래 = 같은 단(column)의 첫 「자료:」「출처:」「Source:」 줄
사이를 그림 한 개로 보고 `pdftoppm` 으로 그 영역만 200dpi PNG 로 렌더링한다(벡터 차트·그림 개체 모두 잡힌다).
「자료:」 줄까지 포함해 잘라 그림 안에 원출처가 남게 한다. 캡션은 글자로 따로 저장(슬라이드 제목 후보).
캡션이 없는 그림(자료 줄만 있는 것)·표지 요약·면책 쪽은 잡지 않는다.
종류 추정: 캡션 낱말로(점유율·로드맵·사업 구조/부문·고객·제품·시장 전망·실적·밸류에이션·기타). 순위는 핵심 사업 칸에 맞는 순.

출력(stdout): 후보 목록 JSON. 그림 파일은 --out 폴더에 {pdf 해시 앞 10자}-p{쪽}-{번호}.png
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
from pathlib import Path

CAPTION_RE = re.compile(r"^\[?\s*(그림|도표|차트|표|Figure|Fig\.|Exhibit|Chart|Table)\s*\.?\s*(\d+)\s*[\.\]:\)]?", re.I)
SOURCE_RE = re.compile(r"^(자료|출처|Source|Sources)\s*[:：]", re.I)
DISCLAIMER_RE = re.compile(r"Compliance Notice|투자의견 (분류|비율)|본 자료는.*(고객|투자자)|당사는 .* 보유하고 있지 않습니다|이해관계", re.I)

KINDS = [
    ("점유율", re.compile(r"점유율|M/S|market share|시장 지배", re.I)),
    ("로드맵", re.compile(r"로드맵|roadmap|개발 일정|양산 일정|타임라인|timeline", re.I)),
    ("고객", re.compile(r"고객|customer|매출처|수주 잔고|backlog", re.I)),
    ("제품", re.compile(r"제품|라인업|line-?up|플랫폼|platform|신제품|HBM\d|모델별", re.I)),
    ("사업 구조·부문", re.compile(r"사업부|부문|segment|사업 구조|구조도|밸류체인|value chain|생태계|ecosystem|매출 (비중|구성)|비중", re.I)),
    ("시장 전망", re.compile(r"시장 (규모|전망)|수요|공급|출하|capex|설비투자|가격 (추이|전망)|ASP", re.I)),
    ("실적", re.compile(r"실적|영업이익|매출액|이익 (추이|전망)|분기", re.I)),
    ("밸류에이션", re.compile(r"밸류|valuation|P/E|P/B|PER|PBR|밴드|band|목표주가|컨센서스|EV/EBITDA|주가", re.I)),
]
RANK = {k: i for i, (k, _) in enumerate(KINDS)}
RANK["기타"] = len(KINDS)


def kind_of(caption: str) -> str:
    for k, rx in KINDS:
        if rx.search(caption):
            return k
    return "기타"


def read_lines(pdf: Path):
    """쪽별 줄 목록 [(xMin, yMin, xMax, yMax, text)] 과 쪽 크기."""
    out = subprocess.run(["pdftotext", "-bbox-layout", str(pdf), "-"], capture_output=True, text=True, check=True).stdout
    pages = []
    for pm in re.finditer(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', out, re.S):
        w, h, body = float(pm.group(1)), float(pm.group(2)), pm.group(3)
        lines = []
        for lm in re.finditer(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</line>', body, re.S):
            words = [html.unescape(x) for x in re.findall(r">([^<]*)</word>", lm.group(5))]
            t = " ".join(words).strip()
            if t:
                lines.append((float(lm.group(1)), float(lm.group(2)), float(lm.group(3)), float(lm.group(4)), t))
        pages.append((w, h, lines))
    return pages


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dpi", type=int, default=200)
    a = ap.parse_args()
    pdf = Path(a.pdf)
    meta = json.loads(Path(a.meta).read_text())
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tag = hashlib.sha1(pdf.read_bytes()).hexdigest()[:10]
    scale = a.dpi / 72
    found = []
    for pno, (pw, ph, lines) in enumerate(read_lines(pdf), start=1):
        if pno == 1:
            continue  # 표지 쪽(요약·투자의견·애널리스트) 제외
        if any(DISCLAIMER_RE.search(t) for *_, t in lines):
            continue
        caps = [ln for ln in lines if CAPTION_RE.match(ln[4])]
        srcs = [ln for ln in lines if SOURCE_RE.match(ln[4])]
        used_src = set()
        pairs = []
        for i, c in enumerate(caps):
            # 같은 단: 아래쪽, 왼쪽 끝이 캡션과 가까운 첫 자료 줄
            below = [s for s in srcs if s[1] > c[3] and abs(s[0] - c[0]) < 40]
            if not below:
                continue
            s = min(below, key=lambda s: s[1])
            # 사이에 다른 캡션(같은 단)이 끼면 캡션만 있고 자료 줄이 없는 그림 — 건너뜀
            if any(o is not c and c[3] < o[1] < s[1] and abs(o[0] - c[0]) < 40 for o in caps):
                continue
            used_src.add(id(s))
            pairs.append((c, s))
        # 번호 없는 캡션(신한·키움 등 「자동차 부문 실적」처럼 번호 없이 제목만): 자료 줄에서 위로 올라가
        # 같은 단의 바로 앞 경계(앞 그림의 자료 줄·본문 문장 줄)를 찾고, 그 아래 첫 줄을 캡션으로 본다.
        for s in srcs:
            if id(s) in used_src:
                continue
            # 단의 가로 범위: 왼쪽 = 자료 줄 시작, 오른쪽 = 같은 높이의 다른 단 자료 줄 시작(없으면 쪽 끝)
            right_srcs = [o[0] for o in srcs if o[0] > s[0] + 80 and abs(o[1] - s[1]) < 30]
            right = min(right_srcs) - 6 if right_srcs else pw
            col = [ln for ln in lines if ln[3] <= s[1] + 0.5 and s[0] - 12 <= ln[0] < right]
            bound = 0.0
            for ln in col:
                is_sentence = len(ln[4]) >= 45 and re.search(r"(다|음|임)[\.。]?\s*$", ln[4])
                is_header = ln[3] < ph * 0.09  # 쪽 머리(날짜·회사명·보고서 이름)
                is_note = re.match(r"^\s*(주|註)\s*\d*\s*[:：)]", ln[4])  # 앞 그림의 주석
                if SOURCE_RE.match(ln[4]) or is_sentence or is_header or is_note:
                    bound = max(bound, ln[3])
            inside = sorted([ln for ln in col if ln[1] > bound + 0.5 and ln[1] < s[1]], key=lambda ln: (ln[1], ln[0]))
            if len(inside) < 3:
                continue
            # 캡션 = 영역 맨 위에서 제목처럼 보이는 줄(한글 포함·4자 이상·단위 괄호나 숫자로 시작하지 않음). 없으면 캡션 없음.
            top = inside[0]
            title = next((ln for ln in inside[:3] if re.search(r"[가-힣A-Za-z]{2}", ln[4]) and len(ln[4]) >= 4 and not re.match(r"^[\(\d]", ln[4])), None)
            pairs.append(((top[0], top[1], top[2], top[1] - 2, title[4] if title else ""), s))
        for c, s in pairs:
            # 오른쪽 끝: 같은 높이에 다른 단의 캡션·자료 줄이 있으면 그 앞까지, 아니면 쪽 오른쪽 여백(왼쪽 여백과 대칭)
            others = [o for o in caps + srcs if o[0] > c[0] + 80 and not (o[3] < c[1] - 5 or o[1] > s[3] + 5)]
            x1 = min(o[0] for o in others) - 6 if others else pw - min(c[0], 40)
            y0 = c[3] + 2
            y1 = min(s[3] + 3, ph)
            # 왼쪽 끝: 영역 안 줄 중 가장 왼쪽(표는 자료 줄보다 왼쪽에서 시작하기도 한다 — 신한), 다른 단 줄은 제외
            inner = [ln[0] for ln in lines if y0 <= ln[1] and ln[3] <= y1 and ln[0] < x1 and ln[0] >= c[0] - 60]
            x0 = max(min([c[0], s[0], *inner]) - 4, 0)
            if (y1 - y0) < 60 or (x1 - x0) < 120:
                continue
            n = len(found) + 1
            name = f"{tag}-p{pno}-{n}.png"
            stem = out / name[:-4]
            subprocess.run(
                ["pdftoppm", "-r", str(a.dpi), "-f", str(pno), "-l", str(pno), "-x", str(int(x0 * scale)), "-y", str(int(y0 * scale)),
                 "-W", str(int((x1 - x0) * scale)), "-H", str(int((y1 - y0) * scale)), "-png", "-singlefile", str(pdf), str(stem)],
                check=True,
            )
            caption = c[4]
            kind = kind_of(caption)
            found.append({
                "file": str(out / name),
                "page": pno,
                "caption": caption,
                "kind": kind,
                "rank": RANK[kind],
                "isTable": bool(re.match(r"^\[?\s*(표|Table)", caption, re.I)),
                "sourceLine": s[4],
                "box": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                "bytes": (out / name).stat().st_size,
                "report": {k: meta.get(k) for k in ("source", "title", "date", "pdfUrl")},
            })
    found.sort(key=lambda f: (f["rank"], f["isTable"], f["page"]))
    json.dump(found, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
