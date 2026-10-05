"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileSpreadsheet, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/query";
import { MARKETS, type MarketId } from "@/lib/markets/types";
import type { BulkCandidate, BulkResolvedRow } from "@/lib/universe/resolve";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 유니버스 일괄 업로드 (오너 지시 2026-10-05 — "현재 방식은 의미가 없다").
 * 입력(붙여넣기·엑셀·CSV) → 서버 해석 → 미리보기 표에서 확인·후보 선택 → 저장.
 * 후보가 여럿이거나 추측인 행은 사람이 고르기 전에는 저장하지 않는다.
 */

const MAX_FILE_BYTES = 1024 * 1024;
const AUTO = "auto";

interface ResolveResponse {
  rows: BulkResolvedRow[];
  notices: string[];
}
interface SaveResponse {
  inserted: number;
  updated: number;
  skipped: { market: string; symbol: string; reason: string }[];
}

const marketLabel = (m: MarketId) => MARKETS.find((x) => x.id === m)?.label ?? m;
const candKey = (c: Pick<BulkCandidate, "market" | "symbol">) => `${c.market}:${c.symbol}`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function BulkUpload({
  existing,
  onDone,
}: {
  /** 내 유니버스 — 이미 등록된 종목 표시용 */
  existing: { market: MarketId; symbol: string }[];
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [defaultMarket, setDefaultMarket] = useState<string>(AUTO);
  const fileRef = useRef<HTMLInputElement>(null);

  const [result, setResult] = useState<ResolveResponse | null>(null);
  /** 행 번호(배열 위치) → 고른 후보 키. "" = 고르지 않음 */
  const [choice, setChoice] = useState<Record<number, string>>({});
  /** 저장에서 뺀 행 */
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  const resolve = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        defaultMarket: defaultMarket === AUTO ? undefined : defaultMarket,
      };
      if (file) {
        if (file.size > MAX_FILE_BYTES) throw new Error("파일이 너무 큽니다(1MB 이하)");
        body.file = { name: file.name, base64: toBase64(await file.arrayBuffer()) };
      } else {
        body.text = text;
      }
      return apiFetch<ResolveResponse>("/api/universe/bulk/resolve", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (res) => {
      setResult(res);
      setChoice({});
      setExcluded(new Set());
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const have = useMemo(() => new Set(existing.map((e) => `${e.market}:${e.symbol}`)), [existing]);

  /** 행마다 저장할 종목(없으면 null)과 중복 여부 */
  const plan = useMemo(() => {
    if (!result) return [];
    const firstLine = new Map<string, number>();
    return result.rows.map((row, i) => {
      let target: BulkCandidate | null = null;
      if (row.status === "confirmed" && row.match) target = row.match;
      else if (row.status === "candidates") {
        target = row.candidates?.find((c) => candKey(c) === choice[i]) ?? null;
      }
      if (excluded.has(i)) target = null;
      let dupOf: number | undefined;
      if (target) {
        const k = candKey(target);
        if (firstLine.has(k)) dupOf = firstLine.get(k);
        else firstLine.set(k, row.line);
      }
      return { target, dupOf, exists: target ? have.has(candKey(target)) : false };
    });
  }, [result, choice, excluded, have]);

  const toSave = plan.filter((p) => p.target && p.dupOf == null);
  const counts = useMemo(() => {
    const rows = result?.rows ?? [];
    return {
      confirmed: rows.filter((r) => r.status === "confirmed").length,
      pending: rows.filter((r, i) => r.status === "candidates" && !choice[i] && !excluded.has(i)).length,
      notFound: rows.filter((r) => r.status === "notFound").length,
    };
  }, [result, choice, excluded]);

  const save = useMutation({
    mutationFn: () =>
      apiFetch<SaveResponse>("/api/universe/bulk", {
        method: "POST",
        body: JSON.stringify({
          items: plan.flatMap((p, i) => {
            if (!p.target || p.dupOf != null) return [];
            const row = result!.rows[i];
            return [
              {
                market: p.target.market,
                symbol: p.target.symbol,
                groupName: row.groupName ?? null,
                tags: row.tags,
                note: row.note ?? null,
              },
            ];
          }),
        }),
      }),
    onSuccess: (res) => {
      const parts = [`신규 ${res.inserted}건`, `기존 갱신 ${res.updated}건`];
      if (res.skipped.length > 0) parts.push(`건너뜀 ${res.skipped.length}건`);
      toast.success(`저장했습니다 — ${parts.join(", ")}`);
      if (res.skipped.length > 0) {
        toast.warning(
          res.skipped.map((s) => `${s.symbol}: ${s.reason}`).join(" / "),
        );
      }
      setResult(null);
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const toggleExclude = (i: number) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const canResolve = (file != null || text.trim().length > 0) && !resolve.isPending;

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">입력 방법</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-1 text-xs">
          <p>
            종목코드나 종목명 어느 쪽이든 넣으면 나머지를 찾아 채웁니다. 쉼표나 줄바꿈으로
            여러 개를 한 번에: <code>삼성전자, 엔비디아, SK하이닉스</code> /{" "}
            <code>005930</code> / <code>AAPL</code>
          </p>
          <p>
            엑셀(.xlsx)·CSV 는 첫 행 헤더를 읽습니다 — <code>시장 · 종목코드(티커) · 종목명 ·
            그룹 · 태그 · 메모</code>(영문 market · code · name · group · tags · note 도 가능).
            헤더가 없으면 첫 열을 코드 또는 종목명으로 봅니다. 엑셀에서 표를 복사해
            붙여넣어도 됩니다. 1MB · 1,000행까지.
          </p>
          <p>
            이미 등록된 종목은 입력에 값이 있는 그룹·태그·메모만 바꾸고, 빈 칸은 그대로
            둡니다.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-sm">시장</Label>
          <Select value={defaultMarket} onValueChange={setDefaultMarket}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>자동 판별</SelectItem>
              {MARKETS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}만
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-sm">파일 (선택)</Label>
          <Input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.txt"
            className="w-72"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        {file && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFile(null);
              if (fileRef.current) fileRef.current.value = "";
            }}
          >
            파일 빼기
          </Button>
        )}
      </div>

      {file ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <FileSpreadsheet className="size-4" />
          {file.name} — 파일을 읽습니다(붙여넣기 칸은 쓰지 않음)
        </p>
      ) : (
        <textarea
          className="border-input bg-transparent focus-visible:ring-ring/50 min-h-[140px] w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"삼성전자, 엔비디아, SK하이닉스\n005930\nAAPL"}
        />
      )}

      <Button variant="outline" onClick={() => resolve.mutate()} disabled={!canResolve}>
        <Search className="size-4" />
        {resolve.isPending ? "찾는 중…" : "종목 찾기"}
      </Button>

      {result && (
        <div className="space-y-3">
          {result.notices.map((n) => (
            <p key={n} className="text-muted-foreground text-xs">
              {n}
            </p>
          ))}
          <p className="text-sm">
            확정 {counts.confirmed}건 · 후보 선택 필요 {counts.pending}건 · 못 찾음{" "}
            {counts.notFound}건
          </p>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="bg-muted/50 text-muted-foreground text-left">
                  <th className="px-3 py-2 font-medium">행</th>
                  <th className="px-3 py-2 font-medium">입력</th>
                  <th className="px-3 py-2 font-medium">시장</th>
                  <th className="px-3 py-2 font-medium">코드</th>
                  <th className="px-3 py-2 font-medium">종목명</th>
                  <th className="px-3 py-2 font-medium">그룹</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2 font-medium">저장</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {result.rows.map((row, i) => (
                  <PreviewRow
                    key={`${row.line}-${i}`}
                    row={row}
                    plan={plan[i]}
                    choice={choice[i] ?? ""}
                    excluded={excluded.has(i)}
                    onChoose={(k) => setChoice((prev) => ({ ...prev, [i]: k }))}
                    onToggle={() => toggleExclude(i)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={toSave.length === 0 || save.isPending}>
              <Upload className="size-4" />
              {save.isPending ? "저장 중…" : `${toSave.length}개 저장`}
            </Button>
            {counts.pending > 0 && (
              <span className="text-muted-foreground text-xs">
                후보를 고르지 않은 {counts.pending}행은 저장하지 않습니다.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewRow({
  row,
  plan,
  choice,
  excluded,
  onChoose,
  onToggle,
}: {
  row: BulkResolvedRow;
  plan: { target: BulkCandidate | null; dupOf?: number; exists: boolean };
  choice: string;
  excluded: boolean;
  onChoose: (key: string) => void;
  onToggle: () => void;
}) {
  const shown = row.status === "confirmed" ? row.match : plan.target ?? undefined;
  const selectable = row.status !== "notFound";

  return (
    <tr className={excluded ? "opacity-50" : undefined}>
      <td className="tnum text-muted-foreground px-3 py-2">{row.line}</td>
      <td className="max-w-[200px] truncate px-3 py-2" title={row.raw}>
        {row.raw}
      </td>
      <td className="px-3 py-2">
        {shown ? <Badge variant="outline">{marketLabel(shown.market)}</Badge> : "-"}
      </td>
      <td className="tnum px-3 py-2">{shown?.symbol ?? "-"}</td>
      <td className="px-3 py-2">
        {row.status === "candidates" ? (
          <Select value={choice} onValueChange={onChoose}>
            <SelectTrigger className="h-8 w-64">
              <SelectValue placeholder={`후보 ${row.candidates?.length ?? 0}개 중 선택`} />
            </SelectTrigger>
            <SelectContent>
              {row.candidates?.map((c) => (
                <SelectItem key={candKey(c)} value={candKey(c)}>
                  {marketLabel(c.market)} · {c.symbol} · {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          (shown?.name ?? "-")
        )}
      </td>
      <td className="px-3 py-2">
        {row.groupName ?? "-"}
        {row.tags && row.tags.length > 0 && (
          <span className="text-muted-foreground ml-1 text-xs">#{row.tags.join(" #")}</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        <Status row={row} plan={plan} />
      </td>
      <td className="px-3 py-2">
        {selectable && (
          <input
            type="checkbox"
            aria-label="저장에 포함"
            checked={!excluded}
            onChange={onToggle}
          />
        )}
      </td>
    </tr>
  );
}

function Status({
  row,
  plan,
}: {
  row: BulkResolvedRow;
  plan: { target: BulkCandidate | null; dupOf?: number; exists: boolean };
}) {
  const lines: ReactNode[] = [];
  if (row.status === "confirmed") {
    lines.push(
      <Badge key="s" variant="secondary">
        확정
      </Badge>,
    );
  } else if (row.status === "candidates") {
    lines.push(
      <Badge key="s" variant="outline">
        {plan.target ? "선택함" : "후보 선택 필요"}
      </Badge>,
    );
  } else {
    lines.push(
      <Badge key="s" variant="destructive">
        못 찾음
      </Badge>,
    );
  }
  const msgs = [
    ...(row.status !== "confirmed" && row.reason ? [row.reason] : []),
    ...(row.notes ?? []),
    ...(plan.target?.via ? [`출처: ${plan.target.via}`] : []),
    ...(plan.dupOf != null ? [`${plan.dupOf}행과 같은 종목 — 저장하지 않음`] : []),
    ...(plan.exists && plan.dupOf == null
      ? ["이미 등록됨 — 입력한 그룹·태그·메모만 반영"]
      : []),
  ];
  return (
    <div className="space-y-0.5">
      {lines}
      {msgs.map((m) => (
        <p key={m} className="text-muted-foreground">
          {m}
        </p>
      ))}
    </div>
  );
}
