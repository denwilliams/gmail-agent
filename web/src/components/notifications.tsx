import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AppNotification } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ago } from "@/util";

const STATUS: Record<AppNotification["status"], { label: string; className: string }> = {
  sent: { label: "Pushed", className: "border-success/25 bg-success/10 text-success" },
  skipped: { label: "In app only", className: "text-muted-foreground" },
  failed: { label: "Push failed", className: "border-destructive/25 bg-destructive/10 text-destructive" },
  demo: { label: "Demo", className: "text-muted-foreground" },
};
const PRIORITY: Record<number, string> = { 5: "Urgent", 4: "Alert", 3: "Digest" };

export function NotificationList({ items }: { items: AppNotification[] }) {
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>;
  return (
    <ul className="space-y-2">
      {items.map((n, i) => (
        <li key={i} className="rounded-md border p-3 text-sm">
          <div className="flex items-start gap-2">
            <span className="font-medium leading-snug">{n.title}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{ago(n.ts)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn("text-[10px]", STATUS[n.status].className)}>{STATUS[n.status].label}</Badge>
            <Badge variant="secondary" className="text-[10px]">{PRIORITY[n.priority] ?? n.priority}</Badge>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">{n.body}</p>
          {n.error && <p className="mt-1.5 text-xs text-destructive">{n.error}</p>}
          {n.click && (
            <a className="mt-1.5 inline-block text-xs underline underline-offset-4" href={n.click} target="_blank" rel="noreferrer">
              Open in Gmail
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Header bell. Shows what was sent, and says plainly when Pushover isn't set up. */
export function NotificationsBell({ tick, pushConfigured }: { tick: number; pushConfigured: boolean }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { api.notifications().then(setItems).catch(() => {}); }, [tick, open]);
  const failed = items.some((n) => n.status === "failed");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
          <Bell />
          {!!items.length && (
            <span className={cn("absolute right-1.5 top-1.5 size-2 rounded-full", failed ? "bg-destructive" : "bg-primary")} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Notifications</h3>
          <p className="text-xs text-muted-foreground">
            {pushConfigured
              ? "Also pushed to your phone with Pushover."
              : "Pushover isn't set up, so these only appear here. Add PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY to get phone pushes."}
          </p>
        </div>
        <ScrollArea className="max-h-96">
          <div className="p-3"><NotificationList items={items} /></div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
