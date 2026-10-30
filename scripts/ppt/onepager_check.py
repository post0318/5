#!/usr/bin/env python3
"""종목 1페이지 PPT — 결과 파일을 다시 읽어 입력(spec)과 기계 대조 (요구사항 §7 점검표).

채우기 코드(onepager_fill.py)의 함수를 쓰지 않고 파일을 직접 열어 읽는다(공통모드 방지). 축 규칙 판정만 같은 수치 조건을 따로 적었다.
결과는 report JSON 의 checks 에 덧붙인다. 실패가 있으면 종료코드 2.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path

from lxml import etree

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
}
EMU = 360000
SLIDE_W, SLIDE_H = 10693400, 7561263


def texts(el) -> str:
    return "".join(t.text or "" for t in el.iter(f"{{{NS['a']}}}t"))


def sizes(el) -> set[str]:
    return {r.get("sz") for r in el.iter(f"{{{NS['a']}}}rPr")}


def rels(z: zipfile.ZipFile, part: str) -> dict[str, str]:
    d, f = part.rsplit("/", 1)
    rp = f"{d}/_rels/{f}.rels"
    if rp not in z.namelist():
        return {}
    root = etree.fromstring(z.read(rp))
    out = {}
    for r in root.findall("rel:Relationship", NS):
        t = r.get("Target")
        if not t.startswith("/"):
            parts = (d + "/" + t).split("/")
            st = []
            for p in parts:
                if p == "..":
                    st.pop()
                elif p != ".":
                    st.append(p)
            t = "/".join(st)
        out[r.get("Id")] = t.lstrip("/")
    return out


def sheet_rows(xlsx: bytes) -> list[list[str]]:
    z = zipfile.ZipFile(io.BytesIO(xlsx))
    sst = []
    if "xl/sharedStrings.xml" in z.namelist():
        sr = etree.fromstring(z.read("xl/sharedStrings.xml"))
        sst = ["".join(t.text or "" for t in si.iter(f"{{{NS['x']}}}t")) for si in sr.findall("x:si", NS)]
    sh = etree.fromstring(z.read("xl/worksheets/sheet1.xml"))
    out = []
    for row in sh.iter(f"{{{NS['x']}}}row"):
        vals: list[str] = []
        for c in row.findall("x:c", NS):
            col = 0
            for ch in re.match(r"[A-Z]+", c.get("r")).group(0):
                col = col * 26 + ord(ch) - 64
            while len(vals) < col - 1:  # 빈 칸은 파일에 없다 — 열 위치를 맞춘다
                vals.append("")
            v = c.find("x:v", NS)
            if v is None:
                isv = c.find("x:is", NS)
                vals.append(texts_x(isv) if isv is not None else "")
            elif c.get("t") == "s":
                vals.append(sst[int(v.text)])
            else:
                vals.append(v.text)
        out.append(vals)
    return out


def texts_x(el):
    return "".join(t.text or "" for t in el.iter(f"{{{NS['x']}}}t"))


def cache_vals(ref) -> list[str]:
    return [v.text for v in ref.iter(f"{{{NS['c']}}}v")]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pptx", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    spec = json.loads(Path(a.spec).read_text())
    rep = json.loads(Path(a.report).read_text())
    checks = rep["checks"]

    def ok(item, cond, detail=""):
        checks.append({"item": item, "ok": bool(cond), "detail": detail, "by": "check"})

    z = zipfile.ZipFile(a.pptx)
    slide_part = "ppt/slides/slide1.xml"
    sl = etree.fromstring(z.read(slide_part))
    srels = rels(z, slide_part)
    tree = sl.find(".//p:spTree", NS)
    shapes = {}
    for el in tree:
        cnv = el.find(".//p:cNvPr", NS)
        if cnv is not None:
            shapes[cnv.get("id")] = el

    # 지운 개체
    for sid, what in (("27", "중복 재무표"), ("5", "INCJ 잔재"), ("38", "빈 쪽번호 글"), ("13", "외부 캡처 그림")):
        ok(f"삭제: {what}", sid not in shapes)
    media = [n for n in z.namelist() if n.startswith("ppt/media/")]
    used = set(srels.values())
    ok("외부 캡처 그림(image7) 파일이 남지 않음", "ppt/media/image7.png" not in z.namelist(), ",".join(media))

    # 슬라이드 밖으로 나간 개체 없음
    out = []
    for sid, el in shapes.items():
        off = el.find(".//a:off", NS)
        ext = el.find(".//a:ext[@cx]", NS)
        if off is None or ext is None:
            continue
        x, y, w, h = int(off.get("x")), int(off.get("y")), int(ext.get("cx")), int(ext.get("cy"))
        if x < 0 or y < 0 or x + w > SLIDE_W or y + h > SLIDE_H:
            name = el.find(".//p:cNvPr", NS).get("name")
            if sid not in ("37",):  # 레이아웃 장식은 원래 위치
                out.append(f"{name}({sid})")
    ok("개체가 슬라이드 안", not out, ",".join(out))

    # 종목명·출처·상품명
    ok("종목명 글", texts(shapes["2"]).strip() == spec["title"], texts(shapes["2"]))
    ok("하단 출처 한 줄 글", texts(shapes["7"]) == spec["sourceLine"], texts(shapes["7"]))
    ok("하단 출처 글자 8pt", sizes(shapes["7"]) == {"800"}, str(sizes(shapes["7"])))
    ok("오른쪽 출처 칸(#7) 지움 — 출처는 한 줄", "54" not in shapes)
    if spec.get("productName"):
        ok("상품명 입력값", texts(shapes["25"]) == spec["productName"])

    # 재무표
    tbl = shapes["12"].find(".//a:tbl", NS)
    trs = tbl.findall("a:tr", NS)
    grid = [[texts(tc) for tc in tr.findall("a:tc", NS)] for tr in trs]
    fin = spec["fin"]
    expect = [[fin["unitHeader"], *fin["headers"]]]
    for k in ("revenue", "growth", "ebitda", "ebitdaMargin", "net", "netMargin", "per"):
        expect.append([fin["labels"][k], *fin["rows"][k]])
    diff = [(i, j, grid[i][j], expect[i][j]) for i in range(8) for j in range(4) if grid[i][j] != expect[i][j]]
    ok("재무표 32칸 = 입력", not diff, str(diff[:5]))
    tsz = sizes(tbl) - {None}
    ok("재무표 글자 한 크기", len(tsz) == 1, str(tsz))
    nonnum = [c for row in expect[1:] for c in row[1:] if c and not re.fullmatch(r"-?[\d,]+(\.\d{2})?", c)]
    ok("재무표 숫자 형식(콤마·소수 둘째 자리)", not nonnum, str(nonnum[:5]))

    # 로고
    if spec.get("logo", {}).get("path"):
        pics = [el for el in tree if el.tag == f"{{{NS['p']}}}pic"]
        lg = [el for el in pics if el.find(".//p:cNvPr", NS).get("name") == "로고"]
        if lg:
            off = lg[0].find(".//a:off", NS)
            ext = lg[0].find(".//a:ext", NS)
            right = (int(off.get("x")) + int(ext.get("cx"))) / EMU
            ok("로고 오른쪽 끝 = 28.97cm", abs(right - 28.97) < 0.01, f"{right:.3f}cm")
            top, h = int(off.get("y")) / EMU, int(ext.get("cy")) / EMU
            ok("로고 칸 안(세로)", top >= 2.099 and top + h <= 3.601, f"{top:.2f}~{top + h:.2f}cm")
        else:
            ok("로고 그림 있음", False)

    # 차트 — 관계 따라 차트·내장 엑셀
    def chart_of(sid):
        el = shapes.get(sid)
        if el is None:
            return None, None
        rid = el.find(".//c:chart", NS).get(f"{{{NS['r']}}}id")
        cp = srels[rid]
        cx = etree.fromstring(z.read(cp))
        crels = rels(z, cp)
        ext = cx.find(".//c:externalData", NS)
        wb = z.read(crels[ext.get(f"{{{NS['r']}}}id")]) if ext is not None else None
        return cx, wb

    pc = spec.get("price")
    if pc:
        cx, wb = chart_of("26")
        sers = cx.findall(".//c:ser", NS)
        sv = [float(v) for v in cache_vals(sers[0].find("c:val", NS))]
        iv = [float(v) for v in cache_vals(sers[1].find("c:val", NS))]
        ok("주가 계열 캐시 = 입력", sv == [float(x) for x in pc["stock"]], f"{len(sv)}점")
        ok("지수 계열 캐시 = 입력", iv == [float(x) for x in pc["index"]], f"{len(iv)}점")
        rows = sheet_rows(wb)
        ok("주가 내장 엑셀 행 수", len(rows) == len(pc["dates"]) + 1, f"{len(rows)}행")
        ok("주가 내장 엑셀 값", all(float(r[2]) == float(p) and float(r[3]) == float(x) for r, p, x in zip(rows[1:], pc["stock"], pc["index"])))
        ok("주가 내장 엑셀 출처·기준 시점 열", rows[0][4:6] == ["출처", "기준 시점"] and rows[1][4] == pc["source"])
        # 가로축 눈금: 6월·12월 마지막 거래일에만 「YY-MM」(파일 캐시에서 다시 읽어 날짜와 대조)
        cat = cache_vals(sers[0].find("c:cat", NS))
        pts = sers[0].find("c:cat", NS).findall(".//c:pt", NS)
        lab = {int(pt.get("idx")): pt.find("c:v", NS).text for pt in pts if pt.find("c:v", NS).text}
        ds = pc["dates"]
        exp = {i: f"{d[2:4]}-{d[5:7]}" for i, d in enumerate(ds) if d[5:7] in ("06", "12") and i + 1 < len(ds) and ds[i + 1][:7] != d[:7]}
        ok("가로축 반기 눈금(6·12월 마지막 거래일)", lab == exp, ", ".join(f"{ds[i]}→{v}" for i, v in sorted(lab.items())))
        ok("가로축 = 항목 축·라벨 건너뛰기 1", cx.find(".//c:catAx/c:tickLblSkip", NS) is not None and cx.find(".//c:dateAx", NS) is None)
        last = len(pc["dates"]) + 1
        fs = [f.text for f in cx.iter(f"{{{NS['c']}}}f")]
        ok("차트 참조 범위 = 데이터 행", all(f.endswith(f"${last}") or f.endswith("$1") for f in fs), str(fs))
        for ax, vals, nm in zip(cx.findall(".//c:valAx", NS), (sv, iv), ("주가", "지수")):
            mn = float(ax.find("c:scaling/c:min", NS).get("val"))
            mx = float(ax.find("c:scaling/c:max", NS).get("val"))
            mu = float(ax.find("c:majorUnit", NS).get("val"))
            rng = mx - mn
            ok(f"{nm} 축 5구간", abs(rng / mu - 5) < 1e-9, f"{mn:g}~{mx:g} 간격 {mu:g}")
            ok(f"{nm} 선이 축 안(여백 2%)", min(vals) >= mn + 0.02 * rng - 1e-6 and max(vals) <= mx - 0.02 * rng + 1e-6, f"데이터 {min(vals):g}~{max(vals):g}")
            ok(f"{nm} 축 단위 표시 없음(실제 값)", ax.find("c:dispUnits", NS) is None)
        a0 = [(float(ax.find("c:scaling/c:min", NS).get("val")), float(ax.find("c:scaling/c:max", NS).get("val"))) for ax in cx.findall(".//c:valAx", NS)]
        fp = (sv[0] - a0[0][0]) / (a0[0][1] - a0[0][0])
        fi = (iv[0] - a0[1][0]) / (a0[1][1] - a0[1][0])
        ok("시작 높이 차 ≤ 2%p(파일에서 다시 계산)", abs(fp - fi) <= 0.02, f"{abs(fp - fi) * 100:.2f}%p")

    sh = spec.get("share")
    if sh:
        cx, wb = chart_of("6")
        ser = cx.find(".//c:ser", NS)
        names = cache_vals(ser.find("c:cat", NS))
        vals = [float(v) for v in cache_vals(ser.find("c:val", NS))]
        ok("도넛 캐시 = 입력", names == [i["name"] for i in sh["items"]] and vals == [float(i["value"]) for i in sh["items"]])
        rows = sheet_rows(wb)
        ok("도넛 내장 엑셀 = 입력", [r[0] for r in rows[1:]] == names and [float(r[1]) for r in rows[1:]] == vals)
        ok("도넛 내장 엑셀 출처·기준 시점", all(r[2] == sh["source"] and r[3] == sh["asOf"] for r in rows[1:]))
        legend = [texts(tr) for tr in shapes["8"].findall(".//a:tr", NS)]
        exp = [f"{i['name']} {i['value'] * 100:.1f}%" for i in sh["items"] if i["name"] != "기타"]
        ok("범례표 = 도넛 값", legend == exp, str(legend))
    Path(a.report).write_text(json.dumps(rep, ensure_ascii=False, indent=2))
    fails = [c for c in checks if not c["ok"]]
    print(f"점검 {len(checks)}개 · 실패 {len(fails)}개 · 빈칸 {len(rep['blanks'])}개")
    for c in fails:
        print(f"  실패: {c['item']} — {c.get('detail', '')}")
    sys.exit(2 if fails else 0)


if __name__ == "__main__":
    main()
