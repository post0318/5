"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const ORDER = ["light", "dark", "system"] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // 하이드레이션 후에만 실제 테마 아이콘을 노출한다 (SSR 불일치 방지).
    // next-themes 권장 패턴 — 마운트 1회 플래그.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const current = (mounted ? theme : "system") ?? "system";
  const Icon = current === "dark" ? Moon : current === "light" ? Sun : Monitor;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="테마 전환"
      onClick={() => {
        const idx = ORDER.indexOf(current as (typeof ORDER)[number]);
        setTheme(ORDER[(idx + 1) % ORDER.length]);
      }}
    >
      <Icon className="size-4" />
    </Button>
  );
}
