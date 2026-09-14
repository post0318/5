"use client";

import { useState } from "react";
import { FileDown } from "lucide-react";
import { toast } from "sonner";
import type { MarketId } from "@/lib/markets/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

async function downloadPptx(url: string, body: unknown, fallbackName: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? `생성 실패 (HTTP ${res.status})`);
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = m?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const TA =
  "border-input focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none";

export function StockPptButton({
  market,
  symbol,
  yahoo,
  name,
}: {
  market: MarketId;
  symbol: string;
  yahoo?: string | null;
  name?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [slideNo, setSlideNo] = useState("02");
  const [brand, setBrand] = useState("");
  const [overview, setOverview] = useState("");
  const [business, setBusiness] = useState("");
  const [ecosystem, setEcosystem] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await downloadPptx(
        "/api/ppt/stock",
        { market, symbol, yahoo: yahoo ?? undefined, slideNo, brand, overview, business, ecosystem },
        `${symbol}.pptx`,
      );
      toast.success("PPT를 내려받았습니다");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileDown className="size-4" />
          PPT 내보내기
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name ?? symbol} · 종목 소개 PPT</DialogTitle>
          <DialogDescription>
            아래 항목은 한 줄에 하나씩 입력하세요. 비워두면 AI가 종목명만으로 자동
            생성합니다(재무제표·주가·로고는 항상 자동).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-3">
            <div className="w-24 space-y-1">
              <span className="text-xs font-medium">슬라이드 번호</span>
              <input
                className={TA}
                value={slideNo}
                onChange={(e) => setSlideNo(e.target.value)}
                placeholder="02"
              />
            </div>
            <div className="flex-1 space-y-1">
              <span className="text-xs font-medium">브랜드 문구 (우측 하단, 선택)</span>
              <input
                className={TA}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="비워두면 표시 안 함"
              />
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium">회사 설명 (상단 밴드)</span>
            <textarea
              className={`${TA} min-h-[60px]`}
              value={overview}
              onChange={(e) => setOverview(e.target.value)}
              placeholder={"2010년 설립된 중국 배달 1위 기업, 알리바바와 시장 양분"}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium">핵심 투자 포인트 (한 줄에 하나, 비우면 AI 자동)</span>
            <textarea
              className={`${TA} min-h-[80px]`}
              value={business}
              onChange={(e) => setBusiness(e.target.value)}
              placeholder={"(비워두면 AI가 자동으로 3줄 생성)\n음식 배달·매장 예약\n호텔·여행, 영화 예매"}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium">
              사업 생태계 다이어그램 (한 줄에 &quot;카테고리:라벨&quot;, 비우면 AI 자동)
            </span>
            <textarea
              className={`${TA} min-h-[80px]`}
              value={ecosystem}
              onChange={(e) => setEcosystem(e.target.value)}
              placeholder={"(비워두면 AI가 자동으로 6~10개 노드 생성)\n지상무기:K9 썬더\n지상무기:천무\n항공우주:누리호 발사체"}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            제목·로고·재무제표·주가차트는 항상 자동 생성됩니다. AI 생성 내용은 학습 데이터
            기반이라 최신 사업이나 정확한 수치는 반영 못할 수 있습니다 — 시장점유율처럼 정확도가
            중요한 항목은 직접 입력을 권장합니다.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={run} disabled={busy}>
            {busy ? "생성 중…" : "PPT 생성"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UniversePptButton({ market }: { market: MarketId }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await downloadPptx("/api/ppt/universe", { market }, `universe_${market}.pptx`);
      toast.success("유니버스 PPT를 내려받았습니다");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={run} disabled={busy}>
      <FileDown className="size-4" />
      {busy ? "생성 중…" : "PPT 일괄 생성"}
    </Button>
  );
}
