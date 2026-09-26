"use client";

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatCurrency, formatMultiple, formatNumber } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AdminVerifyRow } from "@/app/api/admin/verify/route";
import { AUDIT_VERDICT_LABEL, type AuditRow } from "@/lib/db/verify-results";

/**
 * 재무 숫자 검증 결과 — 관리자만(오너 결정 2026-09-24). 검증 스크립트가 GitHub Actions 에서 매일 전 종목,
 * 수시로 새로 담긴 종목을 검증해 올린 결과를 보여준다. 유니버스에 있는데 결과가 없는 종목은 "미검증".
 *
 * 외부 대조는 판정이 아니라 원인 규명 대상 — 소스(Yahoo·StockAnalysis·인포맥스)마다 앱 값과 같은지 나란히 보인다.
 */

type Filter = "issues" | "all" | "pending";
const SOURCES = ["Yahoo", "StockAnalysis", "인포맥스"] as const;

function status(r: AdminVerifyRow): { label: string; tone: "bad" | "warn" | "ok" | "pending" } {
  if (r.pending || !r.result) return { label: "미검증", tone: "pending" };
  const c = r.result.counts;
  // 검사 실패 없이 실행 오류만 있으면 "실패 0" 이 아니라 오류 건수를 보인다(판정은 같다)
  if (c.fail > 0 || r.result.errors.length) return { label: c.fail > 0 ? `실패 ${c.fail}` : `오류 ${r.result.errors.length}`, tone: "bad" };
  if (c.extMismatch > 0 || c.unverifiable > 0) return { label: "확인 필요", tone: "warn" };
  // 공통모드(독립 검증 아님)는 실패가 아니지만 통과로 세지 않는다 — 건수를 보인다
  const cm = (c.common ?? 0) + (c.extCommon ?? 0);
  return { label: cm ? `정상 · 공통모드 ${cm}` : "정상", tone: "ok" };
}

const TONE: Record<string, string> = {
  bad: "bg-destructive/15 text-destructive",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  pending: "bg-muted text-muted-foreground",
};

function fmtWhen(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 금액은 백만 단위로 — 소스마다 보고 단위가 달라 원값 그대로 쓰면 읽기 어렵다 */
const mil = (v: number | null | undefined) => (v == null ? "—" : formatNumber(v / 1e6));

/** 감사표 칸 — 금액은 백만 단위, 주당 값은 달러 소수 2자리, 배수는 x (전부 버림, lib/format) */
const PER_SHARE = new Set(["EPS", "BPS"]);
const MULTIPLE = new Set(["PER", "PBR", "PSR", "EV/EBITDA"]);
function auditCell(metric: string, v: number | null) {
  if (v == null) return "—";
  if (PER_SHARE.has(metric)) return formatCurrency(v, "USD");
  if (MULTIPLE.has(metric)) return formatMultiple(v);
  return mil(v);
}
const VERDICT_TONE: Record<AuditRow["verdict"], string> = {
  "①": "text-emerald-700 dark:text-emerald-400",
  "②": "text-amber-700 dark:text-amber-400",
  "③": "text-destructive",
  SEC: "text-sky-700 dark:text-sky-400",
  COMMON: "text-violet-700 dark:text-violet-400",
  NA: "text-muted-foreground",
  미결: "text-muted-foreground",
};

/** 지표 × (최근 사업연도 · LTM) 감사표 — 읽기 전용(오너 결정 2026-09-26, 펼침 상세 없음) */
function AuditTable({ rows }: { rows: AuditRow[] | undefined }) {
  if (!rows?.length) return <p className="text-muted-foreground">표 데이터 없음 — 검증기 재실행 필요</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>지표</TableHead>
            <TableHead>기준</TableHead>
            <TableHead className="text-right">앱</TableHead>
            <TableHead className="text-right">SEC 원자료</TableHead>
            <TableHead className="text-right">Yahoo</TableHead>
            <TableHead className="text-right">StockAnalysis</TableHead>
            <TableHead className="text-right">인포맥스</TableHead>
            <TableHead>판정</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((x) => (
            <TableRow key={`${x.metric}|${x.period}`} className={cn(!x.closed && "opacity-60")}>
              <TableCell>
                <span className="font-medium">{x.metric}</span>
                {!x.closed && <span className="text-muted-foreground ml-1 text-[10px]">지표 미종결</span>}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {x.period}
                {x.basis && <span className="ml-1">· {x.basis}</span>}
              </TableCell>
              {([x.app, x.sec, x.yahoo, x.sa, x.infomax] as const).map((v, i) => (
                <TableCell key={i} className="tnum text-right">{auditCell(x.metric, v)}</TableCell>
              ))}
              <TableCell className="whitespace-normal">
                <span className={cn("font-medium", VERDICT_TONE[x.verdict])}>{AUDIT_VERDICT_LABEL[x.verdict]}</span>
                {x.note && <span className="text-muted-foreground ml-1.5">{x.note}</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Detail({ r }: { r: AdminVerifyRow }) {
  const res = r.result;
  if (!res) return <p className="text-muted-foreground p-3 text-sm">아직 검증 결과가 없습니다. 다음 자동 검증 때 올라옵니다.</p>;
  const mismatch = res.external.filter((x) => x.verdict && /불일치/.test(x.verdict));
  // 공통모드 소스만 일치한 행은 "일치"가 아니다(검증기 verdict 가 공통모드로 시작)
  const commonExt = res.external.filter((x) => x.verdict?.startsWith("공통모드"));
  const matched = res.external.filter((x) => x.verdict && !/불일치/.test(x.verdict) && !x.verdict.startsWith("공통모드"));
  const other = res.external.filter((x) => !x.verdict);
  return (
    <div className="space-y-4 p-3 text-xs">
      <p className="text-muted-foreground">
        검증 {fmtWhen(res.runAt)} · 통과 {res.counts.pass}
        {res.counts.common != null && ` · 공통모드 ${res.counts.common}(통과에 세지 않음)`} · 대상 {res.base}
        {res.commit ? ` · 커밋 ${res.commit.slice(0, 7)}` : ""}
      </p>
      <section>
        <h4 className="mb-1 font-semibold">감사표 <span className="text-muted-foreground font-normal">(금액 백만 달러 · 주당 값 달러 · 배수 x)</span></h4>
        <AuditTable rows={res.audit} />
      </section>
      {res.errors.length > 0 && (
        <section>
          <h4 className="text-destructive mb-1 font-semibold">실행 오류</h4>
          <ul className="list-disc pl-4">{res.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </section>
      )}
      {res.fails.length > 0 && (
        <section>
          <h4 className="text-destructive mb-1 font-semibold">실패 {res.fails.length}</h4>
          <ul className="space-y-0.5">
            {res.fails.map((f, i) => (
              <li key={i}><span className="font-medium">[{f.layer}] {f.name}</span> · {f.col} — {f.note}</li>
            ))}
          </ul>
        </section>
      )}
      {mismatch.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">외부 대조 불일치 {mismatch.length} <span className="text-muted-foreground font-normal">(백만 단위 — 미국 달러·한국 원, 주식수는 백만 주)</span></h4>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>항목</TableHead>
                  <TableHead className="text-right">앱</TableHead>
                  {SOURCES.map((s) => <TableHead key={s} className="text-right">{s}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {mismatch.map((x, i) => (
                  <TableRow key={i}>
                    <TableCell>{x.item}</TableCell>
                    <TableCell className="tnum text-right">{mil(x.ours)}</TableCell>
                    {SOURCES.map((s) => {
                      const v = x.sources?.[s];
                      const hit = x.matched?.includes(s);
                      return (
                        <TableCell key={s} className={cn("tnum text-right", v != null && !hit && "text-destructive font-medium")}>
                          {v == null ? "—" : mil(v)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
      {res.unverifiable.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">검증불가 {res.unverifiable.length}</h4>
          <ul className="text-muted-foreground space-y-0.5">
            {res.unverifiable.map((f, i) => <li key={i}>[{f.layer}] {f.name} · {f.col} — {f.note}</li>)}
          </ul>
        </section>
      )}
      {(res.common?.length ?? 0) > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">공통모드 — 독립 검증 아님 {res.common?.length} <span className="text-muted-foreground font-normal">(앱과 같은 규칙·데이터로 판정 — 통과에 세지 않음)</span></h4>
          <ul className="text-muted-foreground space-y-0.5">
            {res.common?.map((f, i) => <li key={i}>[{f.layer}] {f.name} · {f.col} — {f.note}</li>)}
          </ul>
        </section>
      )}
      {commonExt.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">외부 대조 공통모드 {commonExt.length}</h4>
          <ul className="text-muted-foreground space-y-0.5">{commonExt.map((x, i) => <li key={i}>{x.item} — {x.verdict}</li>)}</ul>
        </section>
      )}
      {other.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">기타 검토</h4>
          <ul className="text-muted-foreground space-y-0.5">{other.map((x, i) => <li key={i}>{x.item} — {x.note}</li>)}</ul>
        </section>
      )}
      {matched.length > 0 && <p className="text-muted-foreground">외부 소스와 모두 일치 {matched.length}항목</p>}
    </div>
  );
}

export function VerifyBoard() {
  const [filter, setFilter] = useState<Filter>("issues");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["admin-verify"],
    queryFn: () => apiFetch<{ rows: AdminVerifyRow[] }>("/api/admin/verify"),
    staleTime: 60_000,
  });
  const rows = useMemo(() => {
    const all = (q.data?.rows ?? []).slice().sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));
    if (filter === "pending") return all.filter((r) => r.pending);
    if (filter === "issues") return all.filter((r) => status(r).tone !== "ok");
    return all;
  }, [q.data, filter]);
  const counts = useMemo(() => {
    const all = q.data?.rows ?? [];
    return { all: all.length, pending: all.filter((r) => r.pending).length, issues: all.filter((r) => status(r).tone !== "ok").length };
  }, [q.data]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">유니버스 종목 재무 검증</CardTitle>
        <div className="flex gap-1">
          {([["issues", `확인 필요 ${counts.issues}`], ["pending", `미검증 ${counts.pending}`], ["all", `전체 ${counts.all}`]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", filter === k ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading && <Skeleton className="h-64 w-full" />}
        {q.isError && <p className="text-destructive text-sm">{q.error instanceof ApiError ? q.error.message : "검증 결과를 불러오지 못했습니다."}</p>}
        {q.data && rows.length === 0 && <p className="text-muted-foreground py-4 text-sm">해당하는 종목이 없습니다.</p>}
        {q.data && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>시장</TableHead>
                <TableHead>종목</TableHead>
                <TableHead>상태</TableHead>
                <TableHead className="text-right">실패</TableHead>
                <TableHead className="text-right">외부 불일치</TableHead>
                <TableHead className="text-right">검증불가</TableHead>
                <TableHead className="text-right">검증 시각</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const key = `${r.market}:${r.symbol}`;
                const s = status(r);
                const c = r.result?.counts;
                return (
                  <Fragment key={key}>
                    <TableRow className="cursor-pointer" onClick={() => setOpen(open === key ? null : key)}>
                      <TableCell className="uppercase">{r.market}</TableCell>
                      <TableCell>
                        <span className="font-medium">{r.symbol}</span>
                        {r.name && <span className="text-muted-foreground ml-1.5 text-xs">{r.name}</span>}
                      </TableCell>
                      <TableCell><Badge variant="secondary" className={TONE[s.tone]}>{s.label}</Badge></TableCell>
                      <TableCell className="tnum text-right">{c ? c.fail : "—"}</TableCell>
                      <TableCell className="tnum text-right">{c ? c.extMismatch : "—"}</TableCell>
                      <TableCell className="tnum text-right">{c ? c.unverifiable : "—"}</TableCell>
                      <TableCell className="tnum text-muted-foreground text-right text-xs">{r.result ? fmtWhen(r.result.runAt) : "—"}</TableCell>
                    </TableRow>
                    {open === key && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/30 p-0 whitespace-normal">
                          <Detail r={r} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
