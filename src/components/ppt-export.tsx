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
  const [bullets, setBullets] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await downloadPptx(
        "/api/ppt/stock",
        {
          market,
          symbol,
          yahoo: yahoo ?? undefined,
          bullets: bullets
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
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
            개요 문구를 한 줄에 하나씩 입력하세요 (최대 4줄, 비워도 됨). 재무·주가는 자동
            채워집니다.
          </DialogDescription>
        </DialogHeader>
        <textarea
          className="border-input focus-visible:ring-ring/50 min-h-[120px] w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
          value={bullets}
          onChange={(e) => setBullets(e.target.value)}
          placeholder={"2010년 설립된 중국 배달 1위 기업\n요식업 외 영화예매·여행 등으로 사업 확장\n생성형 AI 기업 인수로 서비스 고도화"}
        />
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
