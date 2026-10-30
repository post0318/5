#!/usr/bin/env python3
"""종목 1페이지 PPT — 템플릿 칸 채우기 (docs/ppt/00-requirements.md · 01-template-analysis.md).

템플릿을 그대로 복제해 바탕·좌표·서식은 두고 칸의 글·숫자·차트 데이터만 바꾼다(새로 그리지 않는다).
입력 JSON(spec)은 scripts/ppt/onepager.mts 가 앱 API(하이라이트·컨센서스·시세)와 입력 자료(content)로 만든다.
값이 없는 칸은 빈칸 + 사유(spec.blanks) — 다른 출처·근사로 채우지 않는다.

  python3 onepager_fill.py --template T.pptx --spec S.json --out O.pptx [--check-out C.json]

개체는 이름이 아니라 개체 id 로 찾는다(템플릿에 같은 이름이 중복 — 01 문서 §8-9).
"""

from __future__ import annotations

import argparse
import copy
import io
import json
import math
import sys
from datetime import date
from pathlib import Path

import xlsxwriter
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = lambda t: f"{{{NS_C}}}{t}"  # noqa: E731

EMU_PER_CM = 360000

# ── 템플릿 개체 id (01 문서 §2) ──
ID_TITLE = "2"  # #13 종목명
ID_OVERVIEW = "17"  # #4 개요·투자 포인트
ID_SRC_FIN = "7"  # #6 출처(재무)
ID_SRC_PRICE = "54"  # #7 출처(주가·점유율 통합 — 오너 답 6)
ID_PRODUCT = "25"  # #9 상품명(입력값 — 오너 답 8)
ID_PRICE_CHART = "26"  # 차트1
ID_FIN_DUP = "27"  # #11 중복 재무표 — 삭제
ID_SEG_TITLE = "31"  # #12 핵심 사업 소제목
ID_SHARE_TITLE = "3"  # #14 점유율 소제목
ID_INCJ = "5"  # #15 잔재 — 삭제
ID_DONUT = "6"  # 차트2
ID_LEGEND = "8"  # #17 범례표
ID_ARC = "9"  # #18 원호
ID_LOGO = "11"  # #19 로고
ID_FIN = "12"  # #20 재무표
ID_SEG_PIC = "13"  # #21 외부 캡처 그림 — 지움(핵심 사업 칸 형식은 오너 샘플 대기)
ID_EMPTY_PAGE = "38"  # #3 쪽번호 자리 빈 글 — 삭제

# ── 글자 크기표(오너 답 4, 2026-10-16) ──
SZ_SOURCE = 800  # 출처 8pt 명시
SZ_TABLE = 1200  # 재무표 12pt(오너 2026-10-31 — 표 크기 고정, 넘치면 단위를 바꾼다: onepager.mts)
OVERVIEW_MAX_LINES = 3
FONT_EL = "한화고딕 EL"

# ── 칸 용량(cm) — 넘침 판정(01 문서 §5. 한화고딕 대체 폭 가정: 한글 1em·영문/숫자 0.55em·띄어쓰기 0.3em) ──
CAP_OVERVIEW_CM = 27.38 - 0.79
CAP_TITLE_CM = 24.45 - 1.05 - 0.6
CAP_SUBTITLE_SHARE_CM = 28.6 - 15.38
CAP_LEGEND_CM = 5.91 - 0.2


def char_em(ch: str) -> float:
    o = ord(ch)
    if ch == " ":
        return 0.3
    if 0xAC00 <= o <= 0xD7A3 or 0x3040 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0x3130 <= o <= 0x318F:
        return 1.0
    if ch in "%@WMwm":
        return 0.85
    return 0.55


def text_width_cm(text: str, size_pt: float, spc_hundredth_pt: float = 0) -> float:
    em = sum(char_em(c) for c in text)
    return (em * size_pt + len(text) * spc_hundredth_pt / 100) / 72 * 2.54


# ─────────────────────────── 공통 도구 ───────────────────────────


def shape_by_id(slide, sid: str):
    for sh in slide.shapes:
        if str(sh.shape_id) == sid:
            return sh
    raise SystemExit(f"템플릿에 개체 id={sid} 가 없음 — 템플릿이 바뀌었는지 확인")


def remove_shape(slide, sid: str) -> None:
    sh = shape_by_id(slide, sid)
    el = sh._element
    # 그림·차트가 가리키는 관계를 끊어야 저장 때 그 파일(외부 캡처 등)이 결과물에 남지 않는다.
    for blip in el.iter(f"{{{NS_A}}}blip"):
        rid = blip.get(qn("r:embed"))
        if rid:
            slide.part.drop_rel(rid)
    for ch in el.iter(C("chart")):
        rid = ch.get(qn("r:id"))
        if rid:
            slide.part.drop_rel(rid)
    el.getparent().remove(el)


def set_paragraph(p, text: str, size: int | None = None) -> None:
    """문단 p 의 첫 런 서식(없으면 endParaRPr)을 본으로 런 하나만 남기고 글을 바꾼다."""
    runs = p.findall(qn("a:r"))
    end = p.find(qn("a:endParaRPr"))
    if runs:
        rpr = runs[0].find(qn("a:rPr"))
        rpr = copy.deepcopy(rpr) if rpr is not None else etree.SubElement(etree.Element(qn("a:r")), qn("a:rPr"))
    elif end is not None:
        rpr = copy.deepcopy(end)
        rpr.tag = qn("a:rPr")
    else:
        rpr = etree.Element(qn("a:rPr"))
    for el in p.findall(qn("a:r")) + p.findall(qn("a:br")) + p.findall(qn("a:fld")):
        p.remove(el)
    for k in ("err", "dirty"):
        if k in rpr.attrib:
            del rpr.attrib[k]
    rpr.set("lang", "ko-KR")
    if size is not None:
        rpr.set("sz", str(size))
        if end is not None:
            end.set("sz", str(size))
    if end is None:
        # 빈 칸은 endParaRPr 크기로 줄 높이가 정해진다 — 없으면 기본 18pt 로 행이 늘어난다
        end = copy.deepcopy(rpr)
        end.tag = qn("a:endParaRPr")
        p.append(end)
    if text:
        r = etree.Element(qn("a:r"))
        r.append(rpr)
        t = etree.SubElement(r, qn("a:t"))
        t.text = text
        if end is not None:
            end.addprevious(r)
        else:
            p.append(r)


def set_shape_lines(sh, lines: list[str], size: int | None = None) -> None:
    """글 상자 문단을 lines 개수에 맞춘다(모자라면 마지막 문단 복제, 남으면 삭제). 문단별 서식(색)은 템플릿 것."""
    tx = sh._element.find(qn("p:txBody"))
    ps = tx.findall(qn("a:p"))
    while len(ps) < len(lines):
        n = copy.deepcopy(ps[-1])
        ps[-1].addnext(n)
        ps = tx.findall(qn("a:p"))
    for extra in ps[len(lines):]:
        tx.remove(extra)
    for p, line in zip(tx.findall(qn("a:p")), lines):
        set_paragraph(p, line, size)


def add_note_box(slide, x_cm, y_cm, w_cm, h_cm, text: str, name: str):
    """빈칸 사유 표시(8pt 회색). 사람이 지우기 쉽게 독립 글 상자."""
    tb = slide.shapes.add_textbox(Emu(int(x_cm * EMU_PER_CM)), Emu(int(y_cm * EMU_PER_CM)), Emu(int(w_cm * EMU_PER_CM)), Emu(int(h_cm * EMU_PER_CM)))
    tb.name = name
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    r = p.add_run()
    r.text = text
    r.font.size = Pt(8)
    r.font.name = FONT_EL
    rpr = r._r.find(qn("a:rPr"))
    rpr.set("lang", "ko-KR")
    ea = etree.SubElement(rpr, qn("a:ea"))
    ea.set("typeface", FONT_EL)
    from pptx.dml.color import RGBColor

    r.font.color.rgb = RGBColor(0x8B, 0x8B, 0x8B)
    return tb


def excel_serial(iso: str) -> int:
    y, m, d = (int(x) for x in iso.split("-"))
    return (date(y, m, d) - date(1899, 12, 30)).days


# ─────────────────────────── 주가 축 규칙 (01 문서 §6, 오너 답 5) ───────────────────────────

N_INTERVALS = 5
AXIS_MARGIN = 0.02
AXIS_TOL = 0.02
STEP_MANTISSA = (1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8)


def _clean(x: float) -> float:
    return float(f"{x:.10g}")


def axis_candidates(S: list[float]):
    lo, hi = min(S), max(S)
    span = hi - lo if hi > lo else abs(hi) or 1.0
    out = []
    k0 = math.floor(math.log10(span / N_INTERVALS)) - 1
    for k in range(k0, k0 + 4):
        for m in STEP_MANTISSA:
            st = _clean(m * 10**k)
            rng = st * N_INTERVALS
            u = 10 ** math.floor(math.log10(st))
            top = math.floor((lo - AXIS_MARGIN * rng) / u + 1e-9)
            for kk in range(top - 2 * int(round(st / u)) - 1, top + 1):
                mn = _clean(kk * u)
                mx = _clean(mn + rng)
                if mn <= lo - AXIS_MARGIN * rng + 1e-9 and mx >= hi + AXIS_MARGIN * rng - 1e-9 and (mn >= 0 or lo < 0):
                    out.append({"min": mn, "max": mx, "step": st, "f": (S[0] - mn) / rng, "ratio": rng / span})
    return out


def axis_pair(P: list[float], I: list[float]):
    best = None
    for a in axis_candidates(P):
        for b in axis_candidates(I):
            d = abs(a["f"] - b["f"])
            sc = (d > AXIS_TOL, d if d > AXIS_TOL else 0, a["ratio"] + b["ratio"])
            if best is None or sc < best[0]:
                best = (sc, a, b, d)
    if best is None:
        raise SystemExit("주가 축 후보가 없음")
    return best[1], best[2], best[3]


# ─────────────────────────── 칸별 채우기 ───────────────────────────


def section_title(sh, text: str, width_cm: float | None = None):
    """구역 제목 — 템플릿 서식 그대로(20pt, 오너 2026-10-31 정정: 샘플과 같게).
    템플릿 #12 는 폭 2.39cm·줄바꿈 없음이라 긴 제목이 양옆으로 번진다(LibreOffice 렌더링에서 왼쪽 밖으로 나감) — 폭을 구역 폭으로 넓혀 왼쪽에서 시작하게."""
    set_shape_lines(sh, [text])
    if width_cm is not None:
        sh.width = Emu(round(width_cm * EMU_PER_CM))
        sh._element.find(qn("p:txBody")).find(qn("a:bodyPr")).set("wrap", "square")


def fill_title(slide, spec, rep):
    sh = shape_by_id(slide, ID_TITLE)
    text = spec["title"]
    set_shape_lines(sh, [text])
    w = text_width_cm(text, 14, -80) + 0.6
    rep["checks"].append({"item": "종목명 한 줄 폭", "ok": w <= CAP_TITLE_CM, "detail": f"{w:.1f}cm / {CAP_TITLE_CM:.1f}cm"})


def fill_overview(slide, spec, rep):
    sh = shape_by_id(slide, ID_OVERVIEW)
    lines = [x for x in (spec.get("overview") or []) if x.strip()]
    if not lines:
        reason = spec.get("overviewReason") or "개요·투자 포인트 입력 없음"
        set_shape_lines(sh, [f"(빈칸) {reason}"])
        rep["blanks"].append({"slot": "회사 개요·투자 포인트", "reason": reason})
        return
    if len(lines) > OVERVIEW_MAX_LINES:
        rep["checks"].append({"item": "개요 줄 수", "ok": False, "detail": f"{len(lines)}줄 > {OVERVIEW_MAX_LINES}줄 — 앞 3줄만 넣음, 글을 줄여야 함"})
        lines = lines[:OVERVIEW_MAX_LINES]
    set_shape_lines(sh, lines)
    for i, line in enumerate(lines):
        w = text_width_cm(line, 14, -80)
        rep["checks"].append(
            {"item": f"개요 {i + 1}줄 폭", "ok": w <= CAP_OVERVIEW_CM, "detail": f"{w:.1f}cm / {CAP_OVERVIEW_CM:.1f}cm ({len(line)}자)" + ("" if w <= CAP_OVERVIEW_CM else " — 넘침: 글을 줄여야 함(글자 크기는 줄이지 않음)")}
        )


def fill_sources(slide, spec, rep):
    """하단 출처 줄 두 개(오너 2026-10-31 정정, 샘플과 같게) — 왼쪽 #6 = 핵심 사업·재무표(+ 투자포인트, 결정 대기), 오른쪽 #7 = 점유율·주가.
    항목별 출처는 spec.sources·차트 원데이터 시트에만."""
    for sid, key, label in ((ID_SRC_FIN, "sourceLeft", "왼쪽 출처 줄"), (ID_SRC_PRICE, "sourceRight", "오른쪽 출처 줄")):
        sh = shape_by_id(slide, sid)
        text = spec.get(key) or ""
        if not text:
            remove_shape(slide, sid)
            continue
        set_shape_lines(sh, [text], SZ_SOURCE)
        cap = sh.width / EMU_PER_CM - 0.5
        w = text_width_cm(text, 8, -60)
        rep["checks"].append({"item": f"{label} 한 줄 폭(8pt)", "ok": w <= cap, "detail": f"{w:.1f}cm / {cap:.1f}cm"})


def fill_product(slide, spec, rep):
    sh = shape_by_id(slide, ID_PRODUCT)
    name = spec.get("productName")
    if name:
        set_shape_lines(sh, [name])


def cell_set(cell, text: str, size: int):
    tx = cell._tc.find(qn("a:txBody"))
    ps = tx.findall(qn("a:p"))
    for extra in ps[1:]:
        tx.remove(extra)
    set_paragraph(ps[0], text, size)
    # 글자 윤곽선(투명 0%)은 화면에 안 보이는데 LibreOffice 는 이 윤곽선이 있으면 흰 글자를 그리지 않는다(머리글이 비어 보임, 실측) — 지운다.
    for rpr in list(ps[0].iter(qn("a:rPr"))) + list(ps[0].iter(qn("a:endParaRPr"))):
        ln = rpr.find(qn("a:ln"))
        if ln is not None and ln.find(".//" + qn("a:alpha")) is not None and ln.find(".//" + qn("a:alpha")).get("val") == "0":
            rpr.remove(ln)


def fill_fin_table(slide, spec, rep):
    sh = shape_by_id(slide, ID_FIN)
    tbl = sh.table
    fin = spec["fin"]
    rows = list(tbl.rows)
    if len(rows) != 8 or len(tbl.columns) != 4:
        raise SystemExit(f"재무표 모양이 8×4 가 아님({len(rows)}×{len(tbl.columns)})")
    header = [fin["unitHeader"]] + fin["headers"]
    for j, v in enumerate(header):
        cell_set(tbl.cell(0, j), v, SZ_TABLE)
    keys = ["revenue", "growth", "ebitda", "ebitdaMargin", "net", "netMargin", "per"]
    for i, k in enumerate(keys, start=1):
        label_cell = tbl.cell(i, 0)
        cell_set(label_cell, fin["labels"][k], SZ_TABLE)
        for j, v in enumerate(fin["rows"][k], start=1):
            cell_set(tbl.cell(i, j), v, SZ_TABLE)


def fill_logo(slide, spec, rep):
    logo = spec.get("logo")
    old = shape_by_id(slide, ID_LOGO)
    box = (24.45, 2.10, 4.52, 1.50)  # 칸 — 오너 답 7: 비율 유지·오른쪽 끝(x=28.97)·세로 가운데
    old_el = old._element
    if not logo or not logo.get("path"):
        reason = (logo or {}).get("reason") or "로고 파일 없음"
        remove_shape(slide, ID_LOGO)
        rep["blanks"].append({"slot": "로고", "reason": reason})
        return
    path = logo["path"]
    with Image.open(path) as im:
        w_px, h_px = im.size
        mode = im.mode
        has_alpha = mode in ("RGBA", "LA") or (mode == "P" and "transparency" in im.info)
    ratio = w_px / h_px
    bw, bh = box[2], box[3]
    if ratio >= bw / bh:
        w, h = bw, bw / ratio
    else:
        w, h = bh * ratio, bh
    x = box[0] + bw - w
    y = box[1] + (bh - h) / 2
    # 옛 그림을 먼저 지운다 — 같은 그림 파일이면 python-pptx 가 기존 그림 부분을 다시 쓰므로, 나중에 지우면 관계가 끊겨 그림이 빠진다.
    anchor = old_el.getprevious()
    remove_shape(slide, ID_LOGO)
    pic = slide.shapes.add_picture(path, Emu(round(x * EMU_PER_CM)), Emu(round(y * EMU_PER_CM)), Emu(round(w * EMU_PER_CM)), Emu(round(h * EMU_PER_CM)))
    pic.name = "로고"
    anchor.addnext(pic._element)  # 템플릿과 같은 z 순서
    rep["checks"].append({"item": "로고 투명 배경", "ok": bool(has_alpha), "detail": f"{mode} {w_px}×{h_px}px"})
    rep["checks"].append({"item": "로고 해상도(긴 변 ≥ 1,000px)", "ok": max(w_px, h_px) >= 1000, "detail": f"{max(w_px, h_px)}px"})
    rep["logoBox"] = {"x": x, "y": y, "w": w, "h": h}


# ── 주가 차트 ──


def half_year_labels(dates: list[str]) -> list[str]:
    """반기 눈금(오너 2026-10-31): 6월·12월의 마지막 거래일 자리에 「YY-MM」, 나머지는 빈 글.
    그 달이 아직 끝나지 않은 마지막 달(데이터가 그 달에서 끝남)은 마지막 거래일을 모르므로 표시하지 않는다."""
    out = [""] * len(dates)
    for i, d in enumerate(dates):
        nxt = dates[i + 1] if i + 1 < len(dates) else None
        if d[5:7] in ("06", "12") and nxt is not None and nxt[:7] != d[:7]:
            out[i] = f"{d[2:4]}-{d[5:7]}"
    return out


def write_price_xlsx(spec, labels: list[str]) -> bytes:
    pc = spec["price"]
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True})
    ws = wb.add_worksheet("Sheet1")
    fd = wb.add_format({"num_format": "yyyy-mm-dd"})
    fp = wb.add_format({"num_format": pc["priceFormat"]})
    fi = wb.add_format({"num_format": "#,##0.00"})
    ws.write_row(0, 0, ["일자", "눈금", pc["stockName"], pc["indexName"] + "(우)", "출처", "기준 시점"])
    for i, (d, lb, p, x) in enumerate(zip(pc["dates"], labels, pc["stock"], pc["index"]), start=1):
        ws.write_number(i, 0, excel_serial(d), fd)
        if lb:
            ws.write_string(i, 1, lb)
        ws.write_number(i, 2, p, fp)
        ws.write_number(i, 3, x, fi)
    ws.write_string(1, 4, pc["source"])
    ws.write_string(1, 5, pc["asOf"])
    ws.set_column(0, 0, 11)
    ws.set_column(4, 4, 28)
    wb.close()
    return buf.getvalue()


def date_ax_to_cat_ax(cs) -> None:
    """템플릿 날짜 축(연 단위 「yy」)을 항목 축으로 바꾼다 — 눈금을 「그 달 마지막 거래일」에 정확히 두려면 날짜 축으로는 안 된다
    (날짜 축 눈금은 축 시작일부터 일정 간격). 항목 = 거래일, 라벨은 반기 말 거래일만 글이 있고 나머지는 빈 글, 라벨 건너뛰기 1."""
    plot = cs.find(".//" + C("plotArea"))
    for dax in plot.findall(C("dateAx")):
        cat = etree.Element(C("catAx"))
        for tag in ("axId", "scaling", "delete", "axPos"):
            el = dax.find(C(tag))
            if el is not None:
                cat.append(el)
        nf = etree.SubElement(cat, C("numFmt"))
        nf.set("formatCode", "General")
        nf.set("sourceLinked", "1")
        for tag in ("majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx", "crosses", "auto"):
            el = dax.find(C(tag))
            if el is not None:
                cat.append(el)
        etree.SubElement(cat, C("lblAlgn")).set("val", "ctr")
        etree.SubElement(cat, C("lblOffset")).set("val", "100")
        etree.SubElement(cat, C("tickLblSkip")).set("val", "1")
        etree.SubElement(cat, C("noMultiLvlLbl")).set("val", "1")
        dax.addprevious(cat)
        plot.remove(dax)
    # 스키마 순서: 차트들 → 축들. catAx 가 valAx 사이에 섞여도 되지만 원래 자리(dateAx 자리)를 지켰다.


def set_str_ref(parent, f: str, values: list[str]):
    ref = parent.find(C("strRef"))
    ref.find(C("f")).text = f
    cache = ref.find(C("strCache"))
    for el in list(cache):
        cache.remove(el)
    etree.SubElement(cache, C("ptCount")).set("val", str(len(values)))
    for i, v in enumerate(values):
        pt = etree.SubElement(cache, C("pt"))
        pt.set("idx", str(i))
        etree.SubElement(pt, C("v")).text = v


def set_num_ref(parent, f: str, values: list[float], fmt: str):
    ref = parent.find(C("numRef"))
    ref.find(C("f")).text = f
    cache = ref.find(C("numCache"))
    for el in list(cache):
        cache.remove(el)
    etree.SubElement(cache, C("formatCode")).text = fmt
    etree.SubElement(cache, C("ptCount")).set("val", str(len(values)))
    for i, v in enumerate(values):
        pt = etree.SubElement(cache, C("pt"))
        pt.set("idx", str(i))
        etree.SubElement(pt, C("v")).text = repr(float(v)) if not float(v).is_integer() else str(int(v))


def fill_price_chart(slide, spec, rep):
    pc = spec.get("price")
    sh = shape_by_id(slide, ID_PRICE_CHART)
    if not pc:
        reason = spec.get("priceReason") or "시세 없음"
        x, y, w, h = (v / EMU_PER_CM for v in (sh.left, sh.top, sh.width, sh.height))
        remove_shape(slide, ID_PRICE_CHART)
        add_note_box(slide, x, y + h / 2 - 0.3, w, 0.6, f"(빈칸) 주가 차트: {reason}", "주가 차트 빈칸 사유")
        rep["blanks"].append({"slot": "주가 차트", "reason": reason})
        return
    part = sh.chart_part
    cs = part._element
    n = len(pc["dates"])
    last = n + 1
    labels = half_year_labels(pc["dates"])
    sers = list(cs.iter(C("ser")))
    if len(sers) != 2:
        raise SystemExit("주가 차트 계열이 2개가 아님")
    for idx, ser in enumerate(sers):
        col = "C" if idx == 0 else "D"
        name = pc["stockName"] if idx == 0 else pc["indexName"] + "(우)"
        set_str_ref(ser.find(C("tx")), f"Sheet1!${col}$1", [name])
        catel = ser.find(C("cat"))
        for el in list(catel):
            catel.remove(el)
        sref = etree.SubElement(catel, C("strRef"))
        etree.SubElement(sref, C("f"))
        etree.SubElement(sref, C("strCache"))
        set_str_ref(catel, f"Sheet1!$B$2:$B${last}", labels)
        vals = pc["stock"] if idx == 0 else pc["index"]
        set_num_ref(ser.find(C("val")), f"Sheet1!${col}$2:${col}${last}", vals, pc["priceFormat"] if idx == 0 else "#,##0.00")
    a, b, d = axis_pair(pc["stock"], pc["index"])
    val_axes = list(cs.iter(C("valAx")))
    for ax, sel in zip(val_axes, (a, b)):
        sc = ax.find(C("scaling"))
        for t in ("max", "min"):
            el = sc.find(C(t))
            if el is None:
                el = etree.SubElement(sc, C(t))
            el.set("val", f"{sel[t]:.10g}")
        # 순서: orientation, max, min (스키마 순서)
        ori = sc.find(C("orientation"))
        sc.remove(sc.find(C("max")))
        sc.remove(sc.find(C("min")))
        mx = etree.Element(C("max"))
        mx.set("val", f"{sel['max']:.10g}")
        mn = etree.Element(C("min"))
        mn.set("val", f"{sel['min']:.10g}")
        ori.addnext(mx)
        mx.addnext(mn)
        mu = ax.find(C("majorUnit"))
        mu.set("val", f"{sel['step']:.10g}")
        du = ax.find(C("dispUnits"))
        if du is not None:  # 템플릿 왼쪽 축의 '천 단위 표시'는 단위 표기가 없어 값이 1/1000 로 읽힌다 — 실제 값 그대로
            ax.remove(du)
        nf = ax.find(C("numFmt"))
        if ax is val_axes[0]:
            nf.set("formatCode", pc["axisFormat"])
    date_ax_to_cat_ax(cs)
    part.chart_workbook.update_from_xlsx_blob(write_price_xlsx(spec, labels))
    rep["priceTicks"] = [(d, lb) for d, lb in zip(pc["dates"], labels) if lb]
    rep["priceAxis"] = {"stock": a, "index": b, "startDiff": d}
    rep["checks"].append({"item": "주가·지수 시작 높이 차 ≤ 2%p", "ok": d <= AXIS_TOL, "detail": f"{d * 100:.2f}%p"})


# ── 점유율 도넛 + 범례표 ──


def write_share_xlsx(share) -> bytes:
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True})
    ws = wb.add_worksheet("Sheet1")
    pf = wb.add_format({"num_format": "0.0%"})
    ws.write_row(0, 0, ["항목", "비중", "출처", "기준 시점"])
    for i, it in enumerate(share["items"], start=1):
        ws.write_string(i, 0, it["name"])
        ws.write_number(i, 1, it["value"], pf)
        ws.write_string(i, 2, share["source"])
        ws.write_string(i, 3, share["asOf"])
    ws.set_column(0, 0, 16)
    ws.set_column(2, 2, 24)
    wb.close()
    return buf.getvalue()


def fill_share(slide, spec, rep):
    share = spec.get("share")
    title = shape_by_id(slide, ID_SHARE_TITLE)
    remove_shape(slide, ID_INCJ)
    if not share:
        reason = spec.get("shareReason") or "점유율 입력 없음"
        section_title(title, "산업 점유율")
        for sid in (ID_DONUT, ID_LEGEND, ID_ARC):
            remove_shape(slide, sid)
        add_note_box(slide, 15.38, 8.4, 12.9, 0.8, f"(빈칸) 산업 점유율: {reason}", "점유율 빈칸 사유")
        rep["blanks"].append({"slot": "산업 점유율", "reason": reason})
        return
    items = share["items"]
    section_title(title, share["title"])
    w = text_width_cm(share["title"], 20, -110)
    rep["checks"].append({"item": "점유율 소제목 폭", "ok": w <= CAP_SUBTITLE_SHARE_CM, "detail": f"{w:.1f}cm / {CAP_SUBTITLE_SHARE_CM:.1f}cm"})
    # 도넛 — 시트를 새로 쓰고(템플릿 엑셀 라벨 오류를 베끼지 않음, 오너 확인) 캐시·참조를 같은 값으로
    sh = shape_by_id(slide, ID_DONUT)
    part = sh.chart_part
    cs = part._element
    ser = next(cs.iter(C("ser")))
    n = len(items)
    set_str_ref(ser.find(C("tx")), "Sheet1!$B$1", ["비중"])
    set_str_ref(ser.find(C("cat")), f"Sheet1!$A$2:$A${n + 1}", [it["name"] for it in items])
    set_num_ref(ser.find(C("val")), f"Sheet1!$B$2:$B${n + 1}", [it["value"] for it in items], "0.0%")
    dpts = ser.findall(C("dPt"))
    for dp in dpts[n:]:
        ser.remove(dp)
    if n > len(dpts):
        raise SystemExit(f"점유율 항목 {n}개 > 템플릿 조각 서식 {len(dpts)}개 — 상위 항목 + 기타로 묶어 넣을 것")
    part.chart_workbook.update_from_xlsx_blob(write_share_xlsx(share))
    # 범례표 — 같은 값에서 자동 생성. '기타'는 범례에 넣지 않음(템플릿처럼 회사만)
    legend = [it for it in items if it["name"] != "기타"]
    tsh = shape_by_id(slide, ID_LEGEND)
    tbl_el = tsh._element.find(".//" + qn("a:tbl"))
    trs = tbl_el.findall(qn("a:tr"))
    first, other = trs[0], trs[1]
    for tr in trs:
        tbl_el.remove(tr)
    row_h = int(first.get("h"))
    for i, it in enumerate(legend):
        tr = copy.deepcopy(first if i == 0 else other)
        tbl_el.append(tr)
        tc = tr.find(qn("a:tc"))
        txb = tc.find(qn("a:txBody"))
        ps = txb.findall(qn("a:p"))
        for extra in ps[1:]:
            txb.remove(extra)
        label = f"{it['name']} {it['value'] * 100:.1f}%"
        set_paragraph(ps[0], label)
        wl = text_width_cm(label, 11)
        rep["checks"].append({"item": f"범례표 {i + 1}행 폭", "ok": wl <= CAP_LEGEND_CM, "detail": f"{wl:.1f}cm / {CAP_LEGEND_CM:.1f}cm"})
    for rpr in list(tbl_el.iter(qn("a:rPr"))) + list(tbl_el.iter(qn("a:endParaRPr"))):
        ln = rpr.find(qn("a:ln"))  # 투명 윤곽선 — LibreOffice 가 흰 글자를 안 그림(재무표와 같음)
        if ln is not None and ln.find(".//" + qn("a:alpha")) is not None:
            rpr.remove(ln)
    # 원호 장식(#18): 내 종목 조각(0번, 12시부터 시계 방향)을 따라가게 각도를 맞춘다. 템플릿 여백(시작 +2.1°, 끝 −1.5°) 유지.
    arc = shape_by_id(slide, ID_ARC)
    gds = arc._element.findall(".//" + qn("a:gd"))
    v0 = items[0]["value"]
    start = (270 + 2.1) % 360
    end = (270 + v0 * 360 - 1.5) % 360
    for gd, ang in zip(gds, (start, end)):
        gd.set("fmla", f"val {round(ang * 60000)}")
    gf = tsh._element
    ext = gf.find(qn("p:xfrm")).find(qn("a:ext"))
    ext.set("cy", str(row_h * len(legend)))
    rep["share"] = {"items": items, "legend": [f"{it['name']} {it['value'] * 100:.1f}%" for it in legend]}


# ── 핵심 사업 칸(오너 2026-10-31, 샘플 기준): 회사별 제목(20pt) + 그림 한 개(칸 안 비율 유지·가운데) + 출처는 왼쪽 출처 줄 ──
# 칸 = 템플릿 #21 자리(1.45, 8.26, 12.60×6.42cm — 아래 재무표 15.09 와 0.4cm 띄움). 그림 구하는 방법은 결정 전: 사람이 올린 파일만.

CORE_BOX = (1.45, 8.26, 12.60, 6.42)
CAP_SUBTITLE_SEG_CM = 12.6  # 제목 칸 폭 = 그림 칸 폭(넘치면 두 줄이 되어 그림과 겹침 — 글을 줄인다)


def fill_core_business(slide, spec, rep):
    cb = spec.get("coreBusiness")
    title = shape_by_id(slide, ID_SEG_TITLE)
    pic = shape_by_id(slide, ID_SEG_PIC)
    anchor = pic._element.getprevious()
    remove_shape(slide, ID_SEG_PIC)
    bx, by, bw, bh = CORE_BOX
    if not cb or not (cb.get("image") or {}).get("path"):
        reason = spec.get("coreBusinessReason") or "핵심 사업 그림 없음"
        section_title(title, (cb or {}).get("title") or "핵심 사업", 12.6)
        add_note_box(slide, bx, by + 0.1, bw, 0.8, f"(빈칸) 핵심 사업: {reason}", "핵심 사업 빈칸 사유")
        rep["blanks"].append({"slot": "핵심 사업 그림", "reason": reason})
        return
    if not (cb.get("source") or {}).get("doc") or not (cb.get("source") or {}).get("asOf"):
        raise SystemExit("핵심 사업 그림에 출처(문서·기준 시점)가 없음 — 출처 없는 그림은 넣지 않는다")
    section_title(title, cb["title"], 12.6)
    wt = text_width_cm(cb["title"], 20, -110)
    rep["checks"].append({"item": "핵심 사업 제목 폭", "ok": wt <= CAP_SUBTITLE_SEG_CM, "detail": f"{wt:.1f}cm / {CAP_SUBTITLE_SEG_CM:.1f}cm"})
    path = cb["image"]["path"]
    with Image.open(path) as im:
        w_px, h_px = im.size
    r = w_px / h_px
    w, h = (bw, bw / r) if r >= bw / bh else (bh * r, bh)
    x, y = bx + (bw - w) / 2, by + (bh - h) / 2
    newpic = slide.shapes.add_picture(path, Emu(round(x * EMU_PER_CM)), Emu(round(y * EMU_PER_CM)), Emu(round(w * EMU_PER_CM)), Emu(round(h * EMU_PER_CM)))
    newpic.name = "핵심 사업 그림"
    anchor.addnext(newpic._element)
    rep["coreBusinessBox"] = {"x": x, "y": y, "w": w, "h": h}
    rep["checks"].append({"item": "핵심 사업 그림 해상도(가로 ≥ 1,200px)", "ok": w_px >= 1200, "detail": f"{w_px}×{h_px}px"})


# ─────────────────────────── 실행 ───────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", required=True)
    args = ap.parse_args()
    spec = json.loads(Path(args.spec).read_text())
    prs = Presentation(args.template)
    if len(prs.slides) != 1:
        raise SystemExit("템플릿 슬라이드가 1장이 아님")
    slide = prs.slides[0]
    rep: dict = {"checks": [], "blanks": list(spec.get("blanks") or [])}

    for sid in (ID_FIN_DUP, ID_EMPTY_PAGE):
        remove_shape(slide, sid)
    fill_title(slide, spec, rep)
    fill_overview(slide, spec, rep)
    fill_sources(slide, spec, rep)
    fill_product(slide, spec, rep)
    fill_fin_table(slide, spec, rep)
    fill_logo(slide, spec, rep)
    fill_price_chart(slide, spec, rep)
    fill_share(slide, spec, rep)
    fill_core_business(slide, spec, rep)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    prs.save(args.out)
    Path(args.report).write_text(json.dumps(rep, ensure_ascii=False, indent=2))
    print(f"저장 {args.out}")


if __name__ == "__main__":
    sys.exit(main())
