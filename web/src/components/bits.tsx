import { Moon, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Action } from "@/api";

export const ACTION_LABEL: Record<Action, string> = {
  alert: "Alerted",
  keep: "Kept",
  digest: "Digest",
  archive: "Archived",
};

const ACTION_BADGE: Record<Action, string> = {
  alert: "border-destructive/25 bg-destructive/10 text-destructive",
  keep: "border-success/25 bg-success/10 text-success",
  digest: "border-warning/40 bg-warning/15 text-amber-700 dark:text-warning",
  archive: "border-border bg-muted text-muted-foreground",
};

/** Left accent on a feed card. */
export const ACTION_ACCENT: Record<Action, string> = {
  alert: "border-l-destructive",
  keep: "border-l-success",
  digest: "border-l-warning",
  archive: "border-l-border",
};

export function ActionBadge({ action }: { action: Action }) {
  return (
    <Badge variant="outline" className={cn("font-medium", ACTION_BADGE[action])}>
      {ACTION_LABEL[action]}
    </Badge>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.theme = dark ? "dark" : "light"; } catch {}
  }, [dark]);
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setDark(!dark)}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

export function SectionTitle({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold leading-none tracking-tight">{title}</h2>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}
