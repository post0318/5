// 시험 — 독립 감사 3차(10-16, d4ed2ba 불통과)에서 「되돌려도 시험이 통과」한 수정을 동작으로 지킨다. 외부 요청 없음, 합성 사실.
import { test } from "node:test";
import assert from "node:assert/strict";
import { roundedRetagUnit } from "../common/rawfact.mjs";
import { chainItems } from "../us/items.mjs";
import { revenueBlankItems } from "../jp/adapter.mjs";
import { findFilings } from "../jp/read.mjs";

test("반올림 재태깅 판정(R-US1): 1억·10억·100억만, 금액만, 첫 값이 단위 이상일 때만", () => {
  assert.equal(roundedRetagUnit("166997000000", "167000000000", true), 1e8, "AXP 2017-06-30 총자산 — 1억 단위");
  assert.equal(roundedRetagUnit("188548000000", "189000000000", true), 1e9, "AXP 2021 총자산 — 10억 단위");
  assert.equal(roundedRetagUnit("4130162000", "4130000000", true), null, "1천만 단위는 대상 아님(NVDA FY2014 매출)");
  assert.equal(roundedRetagUnit("1000000", "0", true), null, "첫 값이 1억 미만이면 0 은 반올림 재태깅 아님");
  assert.equal(roundedRetagUnit("30000000", "0", true), null, "첫 값 3천만 → 0 도 아님(1억 반올림이면 0 이지만 크기 조건)");
  assert.equal(roundedRetagUnit("-166997000000", "-167000000000", true), 1e8, "음수도 같은 규칙");
  assert.equal(roundedRetagUnit("166997000000", "167000000000", false), null, "개수 단위(NumberOfPositions 등)는 대상 아님");
  assert.equal(roundedRetagUnit("167000000000", "167000000000", true), null, "같은 값은 재태깅 아님");
});

const usFact = (o) => ({
  concept: { id: o.concept, label: null, standard: true }, filing: { id: o.accn ?? "0000000000-26-000001", form: "10-K", filed_at: "2026-03-01" },
  scope: { consolidation: "consolidated", dims: [] }, period: o.period, value: { num: o.v, unit: "USD" }, placement: null, vintage: null,
  locator: { source: "companyfacts", contextRef: null },
});

test("미국 사슬(③-9): 0개월 기간(시작 = 끝 — 배당 선언일)은 기간 Item 이 아니다", () => {
  const zero = usFact({ concept: "us-gaap:DividendsCommonStock", v: "500000000", period: { kind: "duration", start: "2025-03-14", end: "2025-03-14", months: 0 } });
  const year = usFact({ concept: "us-gaap:DividendsCommonStock", v: "1300000000", period: { kind: "duration", start: "2024-02-03", end: "2025-01-31", months: 12 } });
  const its = chainItems([zero, year]).filter((i) => i.key === "dividends_declared_common");
  assert.deepEqual(its.map((i) => [i.period.months, i.value]), [[12, "1300000000"]], "DELL 형 0개월 배당 선언 Item 이 나오면 안 됨");
});

const jpFace = (concept, end = "2026-03-31") => ({ key: "revenue_face", period: { kind: "duration", start: "2025-04-01", end, months: 12 }, scope: { consolidation: "consolidated", dims: [] }, rule: { concept }, vintage_basis: { filing: "S100TEST" } });

test("일본 매출 빈칸 사유(③-7): 본표 매출 줄이 표준 요소면 판독 실패, 회사 고유면 기대 빈칸, 사슬 값이 있으면 빈칸 없음", () => {
  const std = revenueBlankItems([jpFace("jppfs_cor:OperatingRevenueSPF")]);
  assert.equal(std.length, 1);
  assert.equal(std[0].blank_reason, "parse_failed", "표준 요소를 사슬이 못 집은 것은 판독 실패(「회사 고유」 아님)");
  const ifrs = revenueBlankItems([jpFace("jpigp_cor:SomethingRevenueIFRS")]);
  assert.equal(ifrs[0].blank_reason, "parse_failed");
  const own = revenueBlankItems([jpFace("jpcrp030000-asr_E02144-000:TotalNetRevenuesIFRS")]);
  assert.equal(own[0].blank_reason, "confirmed_absent");
  const chained = { ...jpFace("jppfs_cor:NetSales"), key: "revenue" };
  assert.equal(revenueBlankItems([jpFace("jppfs_cor:NetSales"), chained]).length, 0, "같은 범위·기간 매출 사슬 Item 이 있으면 빈칸을 더하지 않음");
});

test("일본 訂正(③-10): 목록 periodEnd 가 빈 정정 서류는 원 서류의 기간 끝을 이어받고, 원 서류가 없으면 비워 둔다", async () => {
  const lists = {
    "2026-06-20": [{ docID: "S100ORIG", edinetCode: "E00001", docTypeCode: "120", submitDateTime: "2026-06-20 15:00", periodStart: "2025-04-01", periodEnd: "2026-03-31", parentDocID: null, withdrawalStatus: "0", xbrlFlag: "1" }],
    "2026-07-10": [
      { docID: "S100CORR", edinetCode: "E00001", docTypeCode: "130", submitDateTime: "2026-07-10 09:00", periodStart: null, periodEnd: null, parentDocID: "S100ORIG", withdrawalStatus: "0", xbrlFlag: "1" },
      { docID: "S100LOST", edinetCode: "E00001", docTypeCode: "130", submitDateTime: "2026-07-10 10:00", periodStart: null, periodEnd: null, parentDocID: "S100GONE", withdrawalStatus: "0", xbrlFlag: "1" },
    ],
  };
  const ed = { dayList: async (d) => ({ json: { results: lists[d] ?? [] } }) };
  const { byCode, missingDates } = await findFilings(ed, ["E00001"], { from: "2026-06-15", to: "2026-07-12" });
  assert.equal(missingDates.length, 0);
  const docs = Object.fromEntries(byCode.get("E00001").map((d) => [d.id, d]));
  assert.equal(docs.S100CORR.period_end, "2026-03-31");
  assert.equal(docs.S100CORR.period_end_from, "parent");
  assert.equal(docs.S100LOST.period_end ?? null, null, "원 서류를 모르면 기간 끝을 지어내지 않는다(identityGaps 로 남김)");
});
