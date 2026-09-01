import { ExternalLink } from "lucide-react";
import type { DeepLink } from "@/lib/markets/types";

export function DeepLinkList({
  title,
  links,
  hint,
}: {
  title: string;
  links: DeepLink[];
  hint?: string;
}) {
  if (!links.length) return null;
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{title}</div>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      <ul className="flex flex-wrap gap-2">
        {links.map((l) => (
          <li key={l.url}>
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="border-border hover:bg-secondary inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors"
            >
              {l.label}
              <ExternalLink className="size-3" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
