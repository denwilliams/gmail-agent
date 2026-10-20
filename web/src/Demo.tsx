import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type AppNotification, type FakeMessage, type Status } from "./api";
import { Empty, SectionTitle } from "./components/bits";
import { NotificationList } from "./components/notifications";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { ago } from "./util";

const MIN = 60_000;
const HOUR = 3_600_000;
const STEPS: [string, number][] = [["+30 min", 30 * MIN], ["+3 hours", 3 * HOUR], ["+1 day", 24 * HOUR], ["+3 days", 72 * HOUR]];

export function Demo({ status, tick, onChange }: { status: Status; tick: number; onChange: () => void }) {
  const fake = status.fake!;
  const [pushes, setPushes] = useState<AppNotification[]>([]);
  const [msgs, setMsgs] = useState<FakeMessage[]>([]);
  const [pick, setPick] = useState(fake.scenarios[0]?.key ?? "");

  const load = useCallback(() => {
    api.notifications().then(setPushes);
    api.fakeMessages().then(setMsgs);
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  const run = (label: string, p: Promise<unknown>) =>
    p.then(() => { toast.success(label); load(); onChange(); }).catch((e: Error) => toast.error(e.message));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <Card>
        <CardHeader>
          <SectionTitle
            title="Offline demo"
            hint="Gmail, Jev, the models and push are all local stand-ins. Nothing leaves this machine. Deliver some email, poll, then move the clock to see the digest and learning kick in."
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader><SectionTitle title="1. Deliver email" /></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger className="w-80 max-w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fake.scenarios.map((s) => <SelectItem key={s.key} value={s.key}>{s.key} · {s.subject}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button onClick={() => run(`Delivered ${pick}`, api.fakeDeliver({ scenario: pick }))}>Deliver</Button>
          <Button variant="outline" onClick={() => run("Delivered the next sample", api.fakeDeliver({ count: 1 }))}>Next sample</Button>
          <Button variant="outline" onClick={() => run("Delivered every sample", api.fakeDeliver({ all: true }))}>All {fake.scenarios.length}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><SectionTitle title="2. Run the loop" /></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button onClick={() => run("Polled", api.fakeRun("poll"))}>Poll</Button>
          <Button variant="outline" onClick={() => run("Learn pass done", api.fakeRun("learn"))}>Learn</Button>
          <Button variant="outline" onClick={() => run("Digest checked (fires only in a configured hour)", api.fakeRun("digest"))}>Digest check</Button>
          <Button variant="outline" onClick={() => run("Digest sent", api.sendDigest())}>Send digest now</Button>
          <Label className="ml-2 gap-2 font-normal text-muted-foreground">
            <Switch checked={fake.auto} onCheckedChange={(on) => run(on ? "Auto-run on" : "Auto-run off", api.fakeAuto(on))} />
            Run every poll interval
          </Label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <SectionTitle
            title="3. Move the clock"
            hint={<>Demo time is <b className="text-foreground">{new Date(fake.now).toLocaleString()}</b>
              {fake.offsetMs > 0 && <> ({Math.round(fake.offsetMs / HOUR)}h ahead)</>}. Learning waits 30 minutes before judging what you did, and treats unread mail as ignored after 3 days.</>}
          />
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {STEPS.map(([label, ms]) => (
            <Button key={label} variant="outline" onClick={() => run(`Clock ${label}`, api.fakeClock(ms))}>{label}</Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><SectionTitle title="Notifications" hint="What would have been pushed to your phone." /></CardHeader>
        <CardContent><NotificationList items={pushes} /></CardContent>
      </Card>

      <Card>
        <CardHeader><SectionTitle title="Pretend Gmail" hint="Act on a message as you would in Gmail, so the learning loop has something to observe." /></CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Subject</TableHead><TableHead>Labels</TableHead><TableHead className="text-right">You…</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {msgs.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-64 truncate" title={m.from_hdr}>{m.subject}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {m.labels.filter((l) => l !== "UNREAD").map((l) => (
                          <Badge key={l} variant="outline" className="text-[10px]">{l.replace("Label_agent_", "agent:")}</Badge>
                        ))}
                        {m.labels.includes("UNREAD") && <Badge className="text-[10px]">unread</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="space-x-1 whitespace-nowrap text-right">
                      {(["read", "star", "rescue", "archive", "reply"] as const).map((a) => (
                        <Button key={a} size="xs" variant="ghost" className="h-7 px-2" onClick={() => run(`${a}: ${m.subject}`, api.fakeAct(m.id, a))}>{a}</Button>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
                {!msgs.length && <TableRow><TableCell colSpan={3}><Empty>Inbox is empty. Deliver something above.</Empty></TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <AlertDialog>
        <AlertDialogTrigger asChild><Button variant="outline">Reset the demo</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the demo?</AlertDialogTitle>
            <AlertDialogDescription>This wipes every learned weight, rule, email and the pretend inbox.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => run("Demo reset", api.fakeReset())}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
