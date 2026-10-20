import {
  Activity as ActivityIcon, Inbox, LogOut, RefreshCw, Scale, Settings2, Send, ThumbsDown, ThumbsUp, FlaskConical, Undo2, ChevronDown,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { Activity } from "./Activity";
import { api, connect, DIMS, type Action, type Dim, type FeedRow, type Status } from "./api";
import { ACTION_ACCENT, ACTION_LABEL, ActionBadge, Empty, ThemeToggle } from "./components/bits";
import { NotificationsBell } from "./components/notifications";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { ScrollArea } from "./components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Separator } from "./components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet";
import { Slider } from "./components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { Demo } from "./Demo";
import { cn } from "./lib/utils";
import { ago, setClockOffset, until, usd } from "./util";
import { Weights } from "./Weights";

type Filter = "all" | Action;
type View = "feed" | "weights" | "activity" | "demo";

export function App() {
  const [me, setMe] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api.me().then((r) => setMe(r.email));
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      {me === undefined ? null : me ? <Shell email={me} /> : <SignIn />}
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}

function SignIn() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 p-8 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Inbox className="size-6" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Inbox Agent</h1>
            <p className="text-sm text-muted-foreground">Triage, archive and alert, tuned to you.</p>
          </div>
          <Button asChild className="w-full">
            <a href="/auth/login">Sign in</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Shell({ email }: { email: string }) {
  const [view, setViewState] = useState<View>(() => {
    const h = location.hash.slice(1);
    return (["feed", "weights", "activity", "demo"] as string[]).includes(h) ? (h as View) : "feed";
  });
  const setView = (v: View) => { location.hash = v; setViewState(v); };
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [chatTick, setChatTick] = useState(0);
  const [weightsTick, setWeightsTick] = useState(0);
  const [activityTick, setActivityTick] = useState(0);

  const loadFeed = useCallback(() => api.feed().then(setFeed), []);
  const loadStatus = useCallback(
    () => api.status().then((s) => { setClockOffset(s.fake?.offsetMs ?? 0); setStatus(s); }),
    [],
  );

  useEffect(() => {
    loadFeed();
    loadStatus();
    return connect((type) => {
      if (type === "feed") { loadFeed(); loadStatus(); }
      if (type === "settings") loadStatus();
      if (type === "weights") { setWeightsTick((n) => n + 1); loadStatus(); }
      if (type === "activity") { setActivityTick((n) => n + 1); loadStatus(); }
      if (type === "chat") { setChatTick((n) => n + 1); setActivityTick((n) => n + 1); }
    });
  }, [loadFeed, loadStatus]);

  const rows = feed.filter((r) => filter === "all" || r.action === filter);
  const counts = { alert: 0, keep: 0, digest: 0, archive: 0 } as Record<Action, number>;
  feed.forEach((r) => counts[r.action]++);
  const views: [View, string, typeof Inbox][] = [
    ["feed", "Feed", Inbox],
    ["weights", "Weights", Scale],
    ["activity", "Activity", ActivityIcon],
    ...(status?.fake ? [["demo", "Demo", FlaskConical] as [View, string, typeof Inbox]] : []),
  ];

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Inbox className="size-4" />
          </div>
          <span className="font-semibold tracking-tight">Inbox Agent</span>
          {status?.fake && <Badge variant="secondary">Offline demo</Badge>}
        </div>

        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            {views.map(([v, label, Icon]) => (
              <TabsTrigger key={v} value={v} className="gap-1.5">
                <Icon className="size-4" />
                {label}
                {v === "weights" && !!status?.pendingProposals && (
                  <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
                    {status.pendingProposals}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
          {status && <span className="hidden tabular-nums md:inline" title="Jev and Luna spend, last 24 hours">{usd(status.costToday)} today</span>}
          {status?.lastPoll && (
            <span className="hidden px-2 md:inline">
              Polled {ago(status.lastPoll)}{status.nextPoll ? ` · next ${until(status.nextPoll)}` : ""}
            </span>
          )}
          {status?.lastError && <Badge variant="destructive" title={status.lastError}>Error</Badge>}
          {status?.llmError && <Badge variant="destructive" title={status.llmError}>OpenAI error</Badge>}
          <Button variant="outline" size="sm" onClick={() => api.pollNow().then(loadFeed)}>
            <RefreshCw /> Poll now
          </Button>
          <NotificationsBell tick={activityTick} pushConfigured={!!status?.push.configured} />
          <ThresholdsSheet status={status} onSaved={loadStatus} />
          <ThemeToggle />
          <Separator orientation="vertical" className="mx-1 h-6" />
          <span className="hidden max-w-48 truncate lg:inline" title={email}>{email}</span>
          <Button variant="ghost" size="icon" aria-label="Sign out" asChild>
            <a href="/auth/logout"><LogOut /></a>
          </Button>
        </div>
      </header>

      {status && !status.connected && (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-4 py-2 text-sm">
          {status.fake ? "The demo mailbox isn't started." : "Gmail isn't connected."}
          <a className="font-medium underline underline-offset-4" href="/auth/login">
            {status.fake ? "Start the demo" : "Connect your account"}
          </a>
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden lg:grid-cols-[minmax(0,1fr)_400px]">
        <ScrollArea className="h-full min-h-0">
          {view === "feed" && (
            <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
              <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                <TabsList>
                  <TabsTrigger value="all">All <Count n={feed.length} /></TabsTrigger>
                  {(["alert", "keep", "digest", "archive"] as Action[]).map((a) => (
                    <TabsTrigger key={a} value={a}>{ACTION_LABEL[a]} <Count n={counts[a]} /></TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <ul className="space-y-3">
                {rows.map((r) => <FeedCard key={r.id} row={r} onChange={loadFeed} demo={!!status?.fake} />)}
              </ul>
              {!rows.length && <Empty>Nothing here yet. The agent is watching your inbox.</Empty>}
            </div>
          )}
          {view === "weights" && <Weights tick={weightsTick} />}
          {view === "activity" && <Activity tick={activityTick} />}
          {view === "demo" && status?.fake && (
            <Demo status={status} tick={activityTick + weightsTick} onChange={() => { loadFeed(); loadStatus(); }} />
          )}
        </ScrollArea>

        <aside className="hidden h-full min-h-0 flex-col border-l bg-card lg:flex">
          <Chat tick={chatTick} />
        </aside>
      </main>
    </div>
  );
}

const Count = ({ n }: { n: number }) => <span className="ml-1 text-xs tabular-nums text-muted-foreground">{n}</span>;

interface Part { dim: string; key: string; weight: number; applied: boolean }

function FeedCard({ row, onChange, demo }: { row: FeedRow; onChange: () => void; demo: boolean }) {
  const [scope, setScope] = useState<Dim>("sender");
  const [open, setOpen] = useState(false);
  const reasons: string[] = JSON.parse(row.reasons || "[]");
  const parts: Part[] = JSON.parse(row.weight_parts || "[]");
  const act = (p: Promise<unknown>) => p.then(onChange);
  const hidden = row.action === "archive" || row.action === "digest";

  return (
    <li>
      <Card className={cn("gap-0 border-l-4 py-0 shadow-xs", ACTION_ACCENT[row.action])}>
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ActionBadge action={row.action} />
            <span className="capitalize">{row.category} · {row.kind}</span>
            <span className="ml-auto">{ago(row.received_at)}</span>
          </div>

          <div>
            <a
              className="font-medium leading-snug hover:underline"
              href={`https://mail.google.com/mail/u/0/#all/${row.thread_id}`}
              target="_blank" rel="noreferrer"
            >
              {row.subject || "(no subject)"}
            </a>
            <div className="truncate text-sm text-muted-foreground">{row.sender}</div>
          </div>

          {row.summary && <p className="text-sm">{row.summary}</p>}

          <Collapsible open={open} onOpenChange={setOpen}>
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{reasons.join(" · ")}</span>
              <CollapsibleTrigger asChild>
                <button className="inline-flex items-center gap-0.5 underline-offset-4 hover:underline">
                  Why <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
                </button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="mt-2 space-y-1 rounded-md bg-muted p-3 text-xs">
                <div className="font-medium">
                  Attention {Math.round(row.attention * 100)}% · combined weight ×{row.weight.toFixed(2)}
                </div>
                {parts.length ? parts.map((p, i) => (
                  <div key={i} className={cn(!p.applied && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                    {p.dim} <code className="rounded bg-background px-1 py-0.5 font-mono">{p.key}</code> ×{p.weight.toFixed(2)}
                    {!p.applied && <span className="no-underline"> overridden by a more specific weight</span>}
                  </div>
                )) : <div className="text-muted-foreground">No explicit weights applied.</div>}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Select value={scope} onValueChange={(v) => setScope(v as Dim)}>
              <SelectTrigger size="sm" className="w-28" aria-label="Apply to"><SelectValue /></SelectTrigger>
              <SelectContent>{DIMS.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
            </Select>
            <Button size="sm" variant={row.vote > 0 ? "default" : "outline"} onClick={() => act(api.vote(row.id, 1, scope))}>
              <ThumbsUp /> More like this
            </Button>
            <Button size="sm" variant={row.vote < 0 ? "default" : "outline"} onClick={() => act(api.vote(row.id, -1, scope))}>
              <ThumbsDown /> Less
            </Button>
            {hidden && !row.undone && (
              <Button size="sm" variant="ghost" onClick={() => act(api.undo(row.id))}><Undo2 /> Back to inbox</Button>
            )}
          </div>

          {demo && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-dashed pt-2 text-xs text-muted-foreground">
              <span>Pretend you:</span>
              {(["read", "star", "rescue", "archive", "reply"] as const).map((a) => (
                <Button key={a} size="xs" variant="outline" className="h-6 px-2 text-xs" onClick={() => act(api.fakeAct(row.id, a))}>{a}</Button>
              ))}
              {row.outcome && <Badge variant="secondary">learned: {row.outcome}</Badge>}
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

const POLL_PRESETS: [number, string][] = [
  [60, "Every minute"], [120, "Every 2 minutes"], [300, "Every 5 minutes"], [600, "Every 10 minutes"],
  [900, "Every 15 minutes"], [1800, "Every 30 minutes"], [3600, "Every hour"],
];
/** The presets, plus the current value if it was set to something else (say via chat). */
function pollOptions(current: number): [number, string][] {
  if (POLL_PRESETS.some(([s]) => s === current)) return POLL_PRESETS;
  const label = current % 60 === 0 ? `Every ${current / 60} minutes` : `Every ${current} seconds`;
  return [...POLL_PRESETS, [current, label] as [number, string]].sort((a, b) => a[0] - b[0]);
}

function ThresholdsSheet({ status, onSaved }: { status: Status | null; onSaved: () => void }) {
  if (!status) return null;
  const s = status.settings;
  const save = (patch: Partial<typeof s>) => api.saveSettings(patch).then(onSaved);
  const thr = (k: "archiveBelow" | "digestBelow" | "alertAbove" | "urgentAbove", name: string, hint: string) => (
    <div key={k} className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label>{name}</Label>
        <span className="text-sm tabular-nums text-muted-foreground">{s[k].toFixed(2)}</span>
      </div>
      <Slider min={0} max={1} step={0.05} value={[s[k]]} onValueChange={([v]) => save({ [k]: v })} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Thresholds"><Settings2 /></Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Thresholds</SheetTitle>
          <SheetDescription>Where attention scores turn into actions.</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {thr("archiveBelow", "Archive below", "Quietly archived, never shown again.")}
          {thr("digestBelow", "Digest below", "Archived, but included in the next digest.")}
          {thr("alertAbove", "Alert above", "Pushes a notification to your phone.")}
          {thr("urgentAbove", "Urgent at", "Jev's urgency probability that alerts on its own.")}
          <Separator />
          <div className="space-y-2">
            <Label>Check for new mail</Label>
            <Select value={String(s.pollSeconds)} onValueChange={(v) => save({ pollSeconds: Number(v) })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {pollOptions(s.pollSeconds).map(([secs, label]) => (
                  <SelectItem key={secs} value={String(secs)}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Each check is one cheap Gmail request. AI calls only happen when there is new mail.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="digest-hours">Digest at (hours, {s.timezone})</Label>
            <Input
              id="digest-hours"
              defaultValue={s.digestHours.join(", ")}
              placeholder="8, 17"
              onBlur={(e) => save({
                digestHours: e.target.value.split(",").map((h) => h.trim()).filter(Boolean).map(Number).filter((h) => !Number.isNaN(h)),
              })}
            />
          </div>
          <Button variant="outline" onClick={() => api.sendDigest()}>Send digest now</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const SUGGESTIONS = [
  "Treat anything from boss@acme.com as important",
  "Stop alerting me about GitHub CI",
  "Add a category for school notices",
  "Why did you archive that invoice?",
];

function Chat({ tick }: { tick: number }) {
  const [log, setLog] = useState<{ role: string; text: string }[]>([]);
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { api.chatLog().then(setLog); }, [tick]);
  // Scroll only the chat's own viewport. scrollIntoView would also scroll the overflow-hidden page layout.
  useEffect(() => {
    const vp = box.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
    vp?.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  }, [log]);

  const send = (m = text) => {
    m = m.trim();
    if (!m) return;
    setText("");
    setLog((l) => [...l, { role: "user", text: m }]);
    api.send(m);
  };

  return (
    <>
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Tune with chat</h2>
        <p className="text-xs text-muted-foreground">Ask the agent to change weights, rules and categories.</p>
      </div>
      <ScrollArea ref={box} className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {!log.length && (
            <div className="space-y-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="block w-full rounded-lg border bg-background px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {log.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" && "justify-end")}>
              <div className={cn(
                "max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm",
                m.role === "user" && "bg-primary text-primary-foreground",
                m.role === "assistant" && "bg-muted",
                m.role === "error" && "border border-destructive/30 bg-destructive/10 text-destructive",
              )}>
                {m.text}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      <form className="flex gap-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message the agent" />
        <Button type="submit" size="icon" aria-label="Send"><Send /></Button>
      </form>
    </>
  );
}
