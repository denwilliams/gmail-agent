import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, DIMS, type Category, type Dim, type LogRow, type Proposal, type WeightRow } from "./api";
import { Empty, SectionTitle } from "./components/bits";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Slider } from "./components/ui/slider";
import { Switch } from "./components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { cn } from "./lib/utils";
import { ago } from "./util";

const HELP: Record<Dim, string> = {
  sender: "A full address. Wins over stream and domain.",
  stream: "A mailing list or notification stream, such as one GitHub repo and reason. Wins over domain.",
  domain: "Everything from one domain.",
  alias: "Which of your addresses it was sent to. Multiplies with category and kind.",
  category: "What Jev says the email is about. Multiplies with kind and alias.",
  kind: "What sort of message it is: receipt, ask, digest and so on. Multiplies with category and alias.",
};

const fail = (e: Error) => toast.error(e.message);

export function Weights({ tick }: { tick: number }) {
  const [dim, setDim] = useState<Dim>("sender");
  const [rows, setRows] = useState<WeightRow[]>([]);
  const [q, setQ] = useState("");
  const [onlySet, setOnlySet] = useState(false);

  const load = useCallback(() => api.weights(dim).then(setRows).catch(fail), [dim]);
  useEffect(() => { load(); }, [load, tick]);

  const shown = rows.filter((r) => r.key.includes(q.trim().toLowerCase()) && (!onlySet || r.weight !== null));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <Proposals tick={tick} />

      <Card>
        <CardHeader><SectionTitle title="Weights" hint={`${HELP[dim]} 1 is neutral, 0.2 nearly always hidden, 3 strongly boosted.`} /></CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={dim} onValueChange={(v) => setDim(v as Dim)}>
            <TabsList className="flex-wrap">
              {DIMS.map((d) => <TabsTrigger key={d} value={d} className="capitalize">{d}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-4">
            <Input placeholder={`Search ${dim}`} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
            <Label className="gap-2 font-normal text-muted-foreground">
              <Switch checked={onlySet} onCheckedChange={setOnlySet} /> Only weighted
            </Label>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="capitalize">{dim}</TableHead>
                  <TableHead className="text-right">Emails</TableHead>
                  <TableHead className="w-64">Weight</TableHead>
                  <TableHead className="text-right">Preset</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => <WeightRowView key={r.key} dim={dim} row={r} onChange={load} />)}
                {!shown.length && (
                  <TableRow><TableCell colSpan={4}><Empty>Nothing to show yet.</Empty></TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Categories tick={tick} />
      <Rules tick={tick} />
      <ChangeLog tick={tick} />
    </div>
  );
}

function WeightRowView({ dim, row, onChange }: { dim: Dim; row: WeightRow; onChange: () => void }) {
  const [val, setVal] = useState(row.weight ?? 1);
  useEffect(() => setVal(row.weight ?? 1), [row.weight]);
  const isSet = row.weight !== null;
  const preset = (p: "vip" | "normal" | "ignore") => api.preset(dim, row.key, p).then(onChange).catch(fail);
  return (
    <TableRow className={cn(isSet && "bg-primary/5")}>
      <TableCell className="max-w-72 truncate font-mono text-xs" title={row.key}>{row.key}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{row.emails}</TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          <Slider
            min={0.2} max={3} step={0.1} value={[val]}
            onValueChange={([v]) => setVal(v!)}
            onValueCommit={([v]) => api.setWeight(dim, row.key, v!).then(onChange).catch(fail)}
            aria-label={`Weight for ${row.key}`}
          />
          <span className="w-8 text-right text-sm tabular-nums">{isSet || val !== 1 ? val.toFixed(1) : "—"}</span>
          {row.source && <Badge variant="secondary" className="text-[10px]">{row.source}</Badge>}
        </div>
      </TableCell>
      <TableCell className="space-x-1 whitespace-nowrap text-right">
        <Button size="xs" variant="ghost" className="h-7 px-2" onClick={() => preset("vip")}>VIP</Button>
        <Button size="xs" variant="ghost" className="h-7 px-2" onClick={() => preset("normal")}>Normal</Button>
        <Button size="xs" variant="ghost" className="h-7 px-2" onClick={() => preset("ignore")}>Ignore</Button>
      </TableCell>
    </TableRow>
  );
}

function Proposals({ tick }: { tick: number }) {
  const [items, setItems] = useState<Proposal[]>([]);
  const load = useCallback(() => api.proposals().then(setItems), []);
  useEffect(() => { load(); }, [load, tick]);
  if (!items.length) return null;
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader><SectionTitle title="Suggested from what you did" hint="Nothing changes until you accept." /></CardHeader>
      <CardContent className="space-y-3">
        {items.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-4 rounded-md border bg-card p-3">
            <div className="min-w-0 text-sm">
              <div>
                <Badge variant="secondary" className="mr-2">{p.dim}</Badge>
                <span className="font-mono text-xs">{p.key}</span> → <b className="tabular-nums">{p.suggested.toFixed(2)}</b>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{p.reason} · {ago(p.ts)}</div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => api.resolveProposal(p.id, true).then(load)}>Accept</Button>
              <Button size="sm" variant="outline" onClick={() => api.resolveProposal(p.id, false).then(load)}>Dismiss</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Categories({ tick }: { tick: number }) {
  const [cats, setCats] = useState<Category[]>([]);
  const [draft, setDraft] = useState({ name: "", description: "", protected: false });
  const load = useCallback(() => api.categories().then(setCats), []);
  useEffect(() => { load(); }, [load, tick]);
  const save = (c: Category) => api.saveCategory(c).then(setCats).catch(fail);

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="Categories"
          hint={<>Jev reads these descriptions to place each email, so make them concrete. Protected categories are never hidden. Mail that fits nothing goes to <code className="rounded bg-muted px-1 font-mono text-xs">other</code>.</>}
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {cats.map((c) => (
          <CategoryRow key={c.name} cat={c} onSave={save}
            onDelete={() => api.deleteCategory(c.name).then(setCats).catch(fail)} />
        ))}
        <form
          className="flex flex-wrap items-center gap-2 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.name.trim() || !draft.description.trim()) return;
            save(draft).then(() => setDraft({ name: "", description: "", protected: false }));
          }}
        >
          <Input className="w-36" placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Input className="min-w-48 flex-1" placeholder="what belongs here" value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <Label className="gap-2 font-normal">
            <Checkbox checked={draft.protected} onCheckedChange={(v) => setDraft({ ...draft, protected: v === true })} /> Protected
          </Label>
          <Button type="submit">Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CategoryRow({ cat, onSave, onDelete }: { cat: Category; onSave: (c: Category) => void; onDelete: () => void }) {
  const [desc, setDesc] = useState(cat.description);
  useEffect(() => setDesc(cat.description), [cat.description]);
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-sm font-medium">{cat.name}</span>
      <Input value={desc} onChange={(e) => setDesc(e.target.value)}
        onBlur={() => desc !== cat.description && onSave({ ...cat, description: desc })} />
      <Label className="shrink-0 gap-2 font-normal text-muted-foreground">
        <Checkbox checked={cat.protected} onCheckedChange={(v) => onSave({ ...cat, protected: v === true })} /> Protected
      </Label>
      {cat.name !== "other"
        ? <Button variant="ghost" size="icon" aria-label={`Remove ${cat.name}`} onClick={onDelete}><Trash2 /></Button>
        : <span className="size-9 shrink-0" />}
    </div>
  );
}

function Rules({ tick }: { tick: number }) {
  const [rules, setRules] = useState<string[]>([]);
  const [text, setText] = useState("");
  const load = useCallback(() => api.rules().then(setRules), []);
  useEffect(() => { load(); }, [load, tick]);
  return (
    <Card>
      <CardHeader><SectionTitle title="Rules" hint="Standing instructions, in plain English, that Jev follows when judging every email." /></CardHeader>
      <CardContent className="space-y-2">
        {rules.map((r) => (
          <div key={r} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
            <span className="flex-1">{r}</span>
            <Button variant="ghost" size="icon" aria-label="Remove rule" onClick={() => api.deleteRule(r).then(setRules)}><Trash2 /></Button>
          </div>
        ))}
        {!rules.length && <p className="text-sm text-muted-foreground">No rules yet.</p>}
        <form
          className="flex gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) api.addRule(text.trim()).then((r) => { setRules(r); setText(""); });
          }}
        >
          <Input placeholder="e.g. Invoices from suppliers are always important" value={text} onChange={(e) => setText(e.target.value)} />
          <Button type="submit">Add rule</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangeLog({ tick }: { tick: number }) {
  const [log, setLog] = useState<LogRow[]>([]);
  useEffect(() => { api.weightLog().then(setLog); }, [tick]);
  if (!log.length) return null;
  return (
    <Card>
      <CardHeader><SectionTitle title="Recent changes" /></CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableBody>
              {log.slice(0, 20).map((l, i) => (
                <TableRow key={i} className="text-xs">
                  <TableCell className="whitespace-nowrap text-muted-foreground">{ago(l.ts)}</TableCell>
                  <TableCell className="capitalize">{l.dim}</TableCell>
                  <TableCell className="max-w-56 truncate font-mono" title={l.key}>{l.key}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{l.before ?? "—"} → {l.after ?? "cleared"}</TableCell>
                  <TableCell><Badge variant="secondary" className="text-[10px]">{l.source}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{l.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
