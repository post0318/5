#!/usr/bin/env python3
"""템플릿 PPTX(PLUS 더블S 주식신탁 1장)를 복제하고, 지정한 칸의 글자·숫자·차트 캐시만 바꾼다.

레이아웃·폰트·좌표·그림 위치는 템플릿 그대로다.
입력 JSON 은 fill-trust-onepager.mts 가 만든다.
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from datetime import date
from io import BytesIO
from pathlib import Path


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def excel_serial(iso: str) -> int:
    y, m, d = (int(x) for x in iso.split("-"))
    return (date(y, m, d) - date(1899, 12, 30)).days


def set_run_texts(block: str, texts: list[str]) -> str:
    """도형 안의 <a:t> 를 순서대로 교체. 남으면 비우고, 모자라면 마지막 런에 붙인다."""
    parts = re.split(r"(<a:t(?:\s[^>]*)?>)([^<]*)(</a:t>)", block)
    # 0=pre, then triples (open, text, close)
    runs = (len(parts) - 1) // 4
    if runs == 0:
        raise SystemExit("텍스트 런이 없는 도형")
    out = [parts[0]]
    for i in range(runs):
        open_t, _old, close_t = parts[1 + i * 4 : 4 + i * 4]
        if i < len(texts):
            val = texts[i]
        else:
            val = ""
        if i == runs - 1 and len(texts) > runs:
            val = "".join(texts[i:])
        out.append(open_t + esc(val) + close_t + parts[4 + i * 4])
    return "".join(out)


def replace_shape(xml: str, shape_id: str, texts: list[str]) -> str:
    key = f'<p:cNvPr id="{shape_id}"'
    i = xml.find(key)
    if i < 0:
        raise SystemExit(f"도형 id={shape_id} 없음")
    start = xml.rfind("<p:sp", 0, i)
    end = xml.find("</p:sp>", i)
    if start < 0 or end < 0:
        raise SystemExit(f"도형 id={shape_id} 경계 없음")
    end += len("</p:sp>")
    block = xml[start:end]
    return xml[:start] + set_run_texts(block, texts) + xml[end:]


def cell_plain(tc: str) -> str:
    return "".join(re.findall(r"<a:t(?:\s[^>]*)?>([^<]*)</a:t>", tc))


def set_tc_text(tc: str, text: str) -> str:
    """값 칸의 첫 <a:t> 만 바꾸고 나머지는 비운다. 빈 문단(endParaRPr)이면 런을 하나 넣는다."""
    if re.search(r"<a:t(?:\s[^>]*)?>", tc):
        n = {"i": 0}

        def repl(m: re.Match[str]) -> str:
            n["i"] += 1
            val = text if n["i"] == 1 else ""
            return f"{m.group(1)}{esc(val)}{m.group(3)}"

        return re.sub(r"(<a:t(?:\s[^>]*)?>)([^<]*)(</a:t>)", repl, tc)
    if text == "":
        return tc
    m = re.search(r"<a:endParaRPr\b.*?</a:endParaRPr>", tc, re.S)
    if not m:
        return tc
    rpr = m.group(0).replace("endParaRPr", "rPr", 1).replace("</a:rPr>", "</a:rPr>")
    # 태그가 endParaRPr → rPr (여는·닫는 둘 다)
    rpr = re.sub(r"</a:endParaRPr>", "</a:rPr>", rpr)
    rpr = rpr.replace("<a:endParaRPr", "<a:rPr", 1)
    run = f"<a:r>{rpr}<a:t>{esc(text)}</a:t></a:r>"
    return tc[: m.start()] + run + tc[m.end() :]


def split_rows(frame: str) -> list[str]:
    return re.findall(r"<a:tr\b.*?</a:tr>", frame, re.S)


def split_cells(row: str) -> list[str]:
    return re.findall(r"<a:tc\b.*?</a:tc>", row, re.S)


def join_cells(row: str, cells: list[str]) -> str:
    found = split_cells(row)
    if len(found) != len(cells):
        raise SystemExit("셀 개수 불일치")
    out = row
    for old, new in zip(found, cells):
        if old == new:
            continue
        i = out.find(old)
        if i < 0:
            raise SystemExit("셀 위치 없음")
        out = out[:i] + new + out[i + len(old) :]
    return out


def row_kind(label: str, margin_seen: int) -> tuple[str, int]:
    if "구분" in label:
        return "header", margin_seen
    if "성장" in label:
        return "growth", margin_seen
    if "매출" in label:
        return "rev", margin_seen
    if "EBITDA" in label:
        return "ebitda", margin_seen
    if "마진" in label:
        kind = "ebitdaMargin" if margin_seen == 0 else "netMargin"
        return kind, margin_seen + 1
    if "순이익" in label:
        return "net", margin_seen
    if label.strip() == "PER":
        return "per", margin_seen
    return "", margin_seen


def fill_table(frame: str, spec: dict, blank_values: bool) -> str:
    rows = split_rows(frame)
    margin_seen = 0
    new_rows = []
    for row in rows:
        cells = split_cells(row)
        if not cells:
            new_rows.append(row)
            continue
        label = cell_plain(cells[0])
        kind, margin_seen = row_kind(label, margin_seen)
        if blank_values and kind and kind != "header":
            cells = [cells[0]] + [set_tc_text(c, "") for c in cells[1:]]
            new_rows.append(join_cells(row, cells))
            continue
        values: list[str] | None = None
        if kind == "header":
            values = spec.get("headers")
        elif kind:
            values = (spec.get("rows") or {}).get(kind)
        if values:
            for i, val in enumerate(values):
                if 1 + i < len(cells):
                    cells[1 + i] = set_tc_text(cells[1 + i], val if val is not None else "")
        new_rows.append(join_cells(row, cells))
    out = frame
    for old, new in zip(rows, new_rows):
        if old == new:
            continue
        i = out.find(old)
        if i < 0:
            raise SystemExit("행 위치 없음")
        out = out[:i] + new + out[i + len(old) :]
    return out


def blank_frame_texts(frame: str) -> str:
    """표 칸의 글자를 전부 비운다. 점유율처럼 이 종목에 해당하지 않는 표."""
    return re.sub(r"(<a:t(?:\s[^>]*)?>)[^<]*(</a:t>)", r"\1\2", frame)


def blank_share_chart(xml: str) -> str:
    """점유율 소스가 없을 때 도넛 캐시의 회사명·비중을 비운다. 위치·색은 그대로."""

    def repl_num(m: re.Match[str]) -> str:
        block = m.group(0)
        fmt = re.search(r"<c:formatCode>.*?</c:formatCode>", block)
        fmt_s = fmt.group(0) if fmt else "<c:formatCode>General</c:formatCode>"
        n = len(re.findall(r"<c:pt\b", block))
        pts = "".join(f'<c:pt idx="{i}"><c:v>0</c:v></c:pt>' for i in range(n))
        return f'<c:numCache>{fmt_s}<c:ptCount val="{n}"/>{pts}</c:numCache>'

    xml = re.sub(r"<c:numCache>.*?</c:numCache>", repl_num, xml, flags=re.S)

    def repl_str(m: re.Match[str]) -> str:
        block = m.group(0)
        if ">비중<" in block:
            return block
        return re.sub(r"(<c:v>)[^<]*(</c:v>)", r"\1없음\2", block)

    return re.sub(r"<c:strCache>.*?</c:strCache>", repl_str, xml, flags=re.S)


def patch_slide(xml: str, spec: dict) -> str:
    xml = replace_shape(xml, "2", spec["titleRuns"])
    if not spec.get("keepKeyPoints"):
        xml = replace_shape(xml, "17", spec.get("keyPointRuns") or ["핵심포인트 없음 — 앱에 종목 소개 문구가 없습니다."])
    if spec.get("sourceLeftRuns"):
        xml = replace_shape(xml, "7", spec["sourceLeftRuns"])
    if spec.get("sourceRightRuns"):
        xml = replace_shape(xml, "54", spec["sourceRightRuns"])

    frames = list(re.finditer(r"<p:graphicFrame\b.*?</p:graphicFrame>", xml, re.S))
    # 뒤에서부터 바꿔 오프셋이 밀리지 않게
    for m in reversed(frames):
        frame = m.group(0)
        has_per = "<a:t>PER</a:t>" in frame
        has_rev = "매출" in frame
        has_share = "36.0%" in frame or "마이크론" in frame
        new = frame
        if has_per:
            new = fill_table(frame, spec, blank_values=False)
        elif has_rev:
            # 가려진 옛 표(단위가 다른 숫자). 보이는 표가 아니므로 숫자를 비운다.
            new = fill_table(frame, spec, blank_values=True)
        elif has_share and not spec.get("keepShare"):
            new = blank_frame_texts(frame)
        if new != frame:
            xml = xml[: m.start()] + new + xml[m.end() :]
    return xml


def patch_num_caches(xml: str, caches: list[list[str]]) -> str:
    idx = {"i": 0}

    def repl(m: re.Match[str]) -> str:
        i = idx["i"]
        idx["i"] += 1
        if i >= len(caches):
            return m.group(0)
        vals = caches[i]
        fmt = re.search(r"<c:formatCode>.*?</c:formatCode>", m.group(0))
        fmt_s = fmt.group(0) if fmt else "<c:formatCode>General</c:formatCode>"
        pts = "".join(f'<c:pt idx="{n}"><c:v>{v}</c:v></c:pt>' for n, v in enumerate(vals))
        return f'<c:numCache>{fmt_s}<c:ptCount val="{len(vals)}"/>{pts}</c:numCache>'

    out = re.sub(r"<c:numCache>.*?</c:numCache>", repl, xml, flags=re.S)
    if idx["i"] < len(caches):
        raise SystemExit(f"차트 numCache {idx['i']}개 < 필요한 {len(caches)}개")
    return out


def patch_formulas(xml: str, last_row: int) -> str:
    def repl(m: re.Match[str]) -> str:
        f = m.group(1)
        if ":" not in f:
            return m.group(0)
        f2 = re.sub(r"\$(\d+)$", f"${last_row}", f)
        return f"<c:f>{f2}</c:f>"

    return re.sub(r"<c:f>([^<]+)</c:f>", repl, xml)


def patch_chart(xml: str, dates: list[str], px: list[str], ks: list[str], name: str) -> str:
    serials = [str(excel_serial(d)) for d in dates]
    xml = patch_num_caches(xml, [serials, px, serials, ks])
    xml = patch_formulas(xml, 1 + len(dates))
    if name and name != "삼성전자":
        xml = xml.replace("<c:v>삼성전자</c:v>", f"<c:v>{esc(name)}</c:v>", 1)
    return xml


def patch_workbook(xlsx: bytes, dates: list[str], px: list[str], ks: list[str], name: str) -> bytes:
    src = zipfile.ZipFile(BytesIO(xlsx))
    sheet = src.read("xl/worksheets/sheet1.xml").decode("utf-8")
    header = re.search(r"<row r=\"1\".*?</row>", sheet, re.S)
    if not header:
        raise SystemExit("엑셀 머리행 없음")
    rows = [header.group(0)]
    for i, (d, p, k) in enumerate(zip(dates, px, ks), start=2):
        serial = excel_serial(d)
        rows.append(
            f'<row r="{i}" spans="1:3" customFormat="1" x14ac:dyDescent="0.3">'
            f'<c r="A{i}" s="8"><v>{serial}</v></c>'
            f'<c r="B{i}" s="10"><v>{p}</v></c>'
            f'<c r="C{i}" s="9"><v>{k}</v></c>'
            f"</row>"
        )
    sheet2 = re.sub(r"<sheetData>.*?</sheetData>", "<sheetData>" + "".join(rows) + "</sheetData>", sheet, count=1, flags=re.S)
    last = 1 + len(dates)
    sheet2 = re.sub(r'<dimension ref="[^"]*"/>', f'<dimension ref="A1:C{last}"/>', sheet2, count=1)

    sst = src.read("xl/sharedStrings.xml").decode("utf-8")
    if name and name != "삼성전자":
        sst = sst.replace("<t>삼성전자</t>", f"<t>{esc(name)}</t>", 1)

    out = BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == "xl/worksheets/sheet1.xml":
                data = sheet2.encode("utf-8")
            elif info.filename == "xl/sharedStrings.xml":
                data = sst.encode("utf-8")
            dst.writestr(info, data)
    return out.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    spec = json.loads(Path(args.data).read_text())
    template = Path(args.template)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(template) as src:
        files = {i.filename: src.read(i.filename) for i in src.infolist()}

    slide = files["ppt/slides/slide1.xml"].decode("utf-8")
    files["ppt/slides/slide1.xml"] = patch_slide(slide, spec).encode("utf-8")

    if not spec.get("keepShare"):
        files["ppt/charts/chart2.xml"] = blank_share_chart(files["ppt/charts/chart2.xml"].decode("utf-8")).encode("utf-8")

    prices = spec.get("prices") or []
    if prices:
        dates = [r["d"] for r in prices]
        px = [r["px"] for r in prices]
        ks = [r["ks"] for r in prices]
        name = spec.get("chartName") or spec.get("name") or ""
        chart = files["ppt/charts/chart1.xml"].decode("utf-8")
        files["ppt/charts/chart1.xml"] = patch_chart(chart, dates, px, ks, name).encode("utf-8")
        files["ppt/embeddings/Microsoft_Excel_Worksheet.xlsx"] = patch_workbook(
            files["ppt/embeddings/Microsoft_Excel_Worksheet.xlsx"], dates, px, ks, name
        )

    logo = spec.get("logoPath")
    if logo:
        files["ppt/media/image6.png"] = Path(logo).read_bytes()

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        for name, data in files.items():
            dst.writestr(name, data)
    out.write_bytes(buf.getvalue())
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
