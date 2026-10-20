import { useEffect, useState } from "react";
import { api, type Activity as ActivityData, type ChatStep } from "./api";
import { Empty, SectionTitle, Stat } from "./components/bits";
import { Badge } from "./components/ui/badge";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { ago, usd } from "./util";

const STAGE_LABEL: Record<string, string> = {
  classify: "Jev: classify",
  judge: "Jev: judge",
  "judge-fast": "Jev: urgency check (fast path)",
  summary: "Luna: summary",
  digest: "Luna: digest",
};
const stage = (s: string) => STAGE_LABEL[s] ?? s;

export function Activity({ tick }: { tick: number }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [chat, setChat] = useState<ChatStep[]>([]);
  useEffect(() => {
    api.activity().then(setData);
    api.chatActivity().then(setChat).catch(() => setChat([]));
  }, [tick]);

  if (!data) return null;
  const chatCost = chat.reduce((n, s) => n + (s.cost ?? 0), 0);
  const tools = chat.filter((s) => s.kind === "tool").length;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <Card>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          <Stat label="Spend, last 24 hours" value={usd(data.totals.today)} />
          <Stat label="Spend, all time" value={usd(data.totals.all)} />
          <Stat label="Chat spend" value={usd(chatCost)} sub={`${tools} tool calls`} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><SectionTitle title="By stage" /></CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Tokens in</TableHead>
                  <TableHead className="text-right">Tokens out</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byStage.map((s) => (
                  <TableRow key={s.stage}>
                    <TableCell>{stage(s.stage)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.n}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.input_tokens.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.output_tokens.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(s.cost)}</TableCell>
                  </TableRow>
                ))}
                {!data.byStage.length && <TableRow><TableCell colSpan={5}><Empty>No calls yet.</Empty></TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><SectionTitle title="Chat agent" hint="Every tool the agent called, and what came back." /></CardHeader>
        <CardContent className="space-y-2">
          {chat.filter((s) => s.kind !== "model").map((s, i) =>
            s.kind === "tool" ? (
              <div key={i} className="rounded-md border p-3 text-sm">
                <span className="font-mono font-medium">{s.name}</span>
                <pre className="mt-1 overflow-x-auto font-mono text-xs text-muted-foreground">{JSON.stringify(s.args)}</pre>
              </div>
            ) : (
              <div key={i} className="ml-4 flex items-start gap-2 text-xs text-muted-foreground">
                <Badge variant={s.isError ? "destructive" : "secondary"}>{s.isError ? "error" : "result"}</Badge>
                <code className="break-all font-mono">{s.result}</code>
              </div>
            ),
          )}
          {!chat.length && <Empty>No chat yet.</Empty>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><SectionTitle title="Recent calls" /></CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">ms</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.calls.map((c, i) => (
                  <TableRow key={i} className="text-xs">
                    <TableCell className="whitespace-nowrap text-muted-foreground">{ago(c.ts)}</TableCell>
                    <TableCell className="max-w-56 truncate" title={c.subject ?? ""}>{c.subject ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{stage(c.stage)}</TableCell>
                    <TableCell className="text-right tabular-nums">{(c.input_tokens + c.output_tokens).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.ms}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(c.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
