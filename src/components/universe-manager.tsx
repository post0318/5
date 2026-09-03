"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/query";
import { MARKETS, type MarketId } from "@/lib/markets/types";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Item {
  id: string;
  market: MarketId;
  symbol: string;
  name: string | null;
  groupName: string | null;
  tags: string[];
  active: boolean;
}

interface BulkResult {
  preview: { market: MarketId; symbol: string; name?: string | null }[];
  errors: { line: number; raw: string; reason: string }[];
  inserted: number;
}

export function UniverseManager() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["universe"],
    queryFn: () => apiFetch<{ items: Item[] }>("/api/universe"),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["universe"] });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">유니버스 관리</h1>

      <Tabs defaultValue="single">
        <TabsList>
          <TabsTrigger value="single">개별 등록</TabsTrigger>
          <TabsTrigger value="bulk">일괄 업로드</TabsTrigger>
        </TabsList>
        <TabsContent value="single" className="pt-4">
          <SingleForm onDone={invalidate} />
        </TabsContent>
        <TabsContent value="bulk" className="pt-4">
          <BulkForm onDone={invalidate} />
        </TabsContent>
      </Tabs>

      <div>
        <h2 className="mb-2 text-sm font-medium">
          등록 종목 {list.data ? `(${list.data.items.length})` : ""}
        </h2>
        {list.isLoading && <p className="text-muted-foreground text-sm">불러오는 중…</p>}
        {list.data && list.data.items.length === 0 && (
          <p className="text-muted-foreground text-sm">등록된 종목이 없습니다.</p>
        )}
        {list.data && list.data.items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted/50 text-muted-foreground text-left">
                  <th className="px-3 py-2 font-medium">시장</th>
                  <th className="px-3 py-2 font-medium">종목코드</th>
                  <th className="px-3 py-2 font-medium">이름</th>
                  <th className="px-3 py-2 font-medium">그룹</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.items.map((item) => (
                  <Row key={item.id} item={item} onChange={invalidate} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ item, onChange }: { item: Item; onChange: () => void }) {
  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      apiFetch(`/api/universe/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      }),
    onSuccess: onChange,
  });
  const del = useMutation({
    mutationFn: () => apiFetch(`/api/universe/${item.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`${item.symbol} 삭제됨`);
      onChange();
    },
  });

  return (
    <tr>
      <td className="px-3 py-2">
        <Badge variant="outline">{MARKETS.find((m) => m.id === item.market)?.label}</Badge>
      </td>
      <td className="tnum px-3 py-2">{item.symbol}</td>
      <td className="px-3 py-2">{item.name ?? "-"}</td>
      <td className="px-3 py-2">{item.groupName ?? "-"}</td>
      <td className="px-3 py-2">
        <button
          className={
            item.active
              ? "text-up text-xs font-medium"
              : "text-muted-foreground text-xs"
          }
          onClick={() => toggle.mutate(!item.active)}
          disabled={toggle.isPending}
        >
          {item.active ? "활성" : "비활성"}
        </button>
      </td>
      <td className="px-3 py-2 text-right">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => del.mutate()}
          disabled={del.isPending}
          aria-label="삭제"
        >
          <Trash2 className="size-4" />
        </Button>
      </td>
    </tr>
  );
}

function SingleForm({ onDone }: { onDone: () => void }) {
  const [market, setMarket] = useState<MarketId>("kr");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");

  const add = useMutation({
    mutationFn: () =>
      apiFetch("/api/universe", {
        method: "POST",
        body: JSON.stringify({
          market,
          symbol,
          name: name || undefined,
          groupName: groupName || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success(`${symbol} 추가됨`);
      setSymbol("");
      setName("");
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-[120px_1fr_1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (symbol.trim()) add.mutate();
      }}
    >
      <div className="space-y-1">
        <Label>시장</Label>
        <Select value={market} onValueChange={(v) => setMarket(v as MarketId)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MARKETS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>종목코드</Label>
        <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="005930 / AAPL / 7203" />
      </div>
      <div className="space-y-1">
        <Label>이름 (선택)</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label>그룹 (선택)</Label>
        <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} />
      </div>
      <Button type="submit" disabled={add.isPending}>
        추가
      </Button>
    </form>
  );
}

function BulkForm({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [defaultMarket, setDefaultMarket] = useState<MarketId>("kr");

  const preview = useMutation({
    mutationFn: () =>
      apiFetch<BulkResult>("/api/universe/bulk", {
        method: "POST",
        body: JSON.stringify({ text, defaultMarket, dryRun: true }),
      }),
  });
  const commit = useMutation({
    mutationFn: () =>
      apiFetch<BulkResult>("/api/universe/bulk", {
        method: "POST",
        body: JSON.stringify({ text, defaultMarket }),
      }),
    onSuccess: (res) => {
      toast.success(`${res.inserted}건 등록됨`);
      setText("");
      preview.reset();
      onDone();
    },
  });

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">붙여넣기 형식</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-1 text-xs">
          <p>
            한 줄에 하나씩. <code>market,symbol,이름,그룹</code> 또는 기본 시장 지정 시{" "}
            <code>symbol</code>만.
          </p>
          <p>예: <code>us,AAPL,Apple,코어</code> / <code>005930</code> / <code>jp,7203</code></p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Label className="text-sm">기본 시장</Label>
        <Select value={defaultMarket} onValueChange={(v) => setDefaultMarket(v as MarketId)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MARKETS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <textarea
        className="border-input bg-transparent focus-visible:ring-ring/50 min-h-[160px] w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-[3px] focus-visible:outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"us,AAPL,Apple,코어\n005930,삼성전자\njp,7203"}
      />

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => preview.mutate()}
          disabled={!text.trim() || preview.isPending}
        >
          미리보기
        </Button>
        <Button
          onClick={() => commit.mutate()}
          disabled={!text.trim() || commit.isPending}
        >
          <Upload className="size-4" />
          등록
        </Button>
      </div>

      {preview.data && (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            유효 {preview.data.preview.length}건
            {preview.data.errors.length > 0 && `, 오류 ${preview.data.errors.length}건`}
          </p>
          {preview.data.errors.length > 0 && (
            <ul className="text-destructive space-y-0.5 text-xs">
              {preview.data.errors.map((e) => (
                <li key={e.line}>
                  {e.line}행: {e.reason} — <code>{e.raw}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
