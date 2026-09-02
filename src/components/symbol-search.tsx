"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { MarketId } from "@/lib/markets/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface SymbolHit {
  symbol: string;
  name: string;
  exchange?: string;
  yahooSymbol?: string;
}

const PLACEHOLDER: Record<MarketId, string> = {
  kr: "종목명 또는 코드 (예: 삼성전자, 005930)",
  us: "Name or ticker (e.g. Apple, AAPL)",
  jp: "銘柄名 또는 코드 (예: Toyota, 7203)",
};

export function SymbolSearch({
  market,
  onSelect,
}: {
  market: MarketId;
  onSelect: (hit: SymbolHit) => void;
}) {
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const q = useQuery({
    queryKey: ["symbol-search", market, debounced],
    queryFn: () =>
      apiFetch<{ hits: SymbolHit[] }>(
        `/api/markets/${market}/search?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length >= 1,
    staleTime: 5 * 60_000,
  });

  const hits = q.data?.hits ?? [];
  const [submitting, setSubmitting] = useState(false);

  function choose(hit: SymbolHit) {
    setInput("");
    setDebounced("");
    setOpen(false);
    onSelect(hit);
  }

  /** 시장별 "코드 직접 입력"으로 볼 수 있는 패턴 */
  function looksLikeCode(v: string): boolean {
    if (market === "kr") return /^[A-Za-z]?\d{4,6}$/.test(v);
    if (market === "jp") return /^\d{4}[A-Za-z]?$/.test(v);
    return /^[A-Za-z][A-Za-z.\-]{0,6}$/.test(v); // us 티커
  }

  async function submit() {
    const v = input.trim();
    if (!v) return;

    // 1) 이미 결과가 있으면 (하이라이트 → 없으면 첫 항목)
    if (hits.length > 0) {
      return choose(hits[active] ?? hits[0]);
    }
    // 2) 코드처럼 보이면 그대로 조회 (어댑터가 정규화)
    if (looksLikeCode(v)) {
      return choose({ symbol: v, name: v });
    }
    // 3) 이름 입력인데 디바운스/로딩이 아직이면 즉시 검색해서 첫 결과 선택
    setSubmitting(true);
    try {
      const res = await apiFetch<{ hits: SymbolHit[] }>(
        `/api/markets/${market}/search?q=${encodeURIComponent(v)}`,
      );
      if (res.hits.length > 0) {
        choose(res.hits[0]);
      } else {
        toast.error(`"${v}" 검색 결과가 없습니다. 종목코드를 입력해 보세요.`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div ref={boxRef} className="relative max-w-lg">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={PLACEHOLDER[market]}
          aria-label="종목 검색"
          autoComplete="off"
        />
        <Button type="button" onClick={() => void submit()} disabled={submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          조회
        </Button>
      </div>

      {open && debounced.length >= 1 && (
        <div className="bg-popover absolute z-20 mt-1 w-full overflow-hidden rounded-md border shadow-md">
          {q.isFetching && (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm">
              <Loader2 className="size-3.5 animate-spin" />
              검색 중…
            </div>
          )}
          {!q.isFetching && hits.length === 0 && (
            <div className="text-muted-foreground px-3 py-2 text-sm">
              결과 없음 — 코드를 직접 입력하고 조회하세요.
            </div>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.symbol}-${i}`}
              type="button"
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm",
                i === active ? "bg-accent" : "hover:bg-accent/50",
              )}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(h)}
            >
              <span className="truncate">{h.name}</span>
              <span className="text-muted-foreground tnum shrink-0 text-xs">
                {h.symbol}
                {h.exchange ? ` · ${h.exchange}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
