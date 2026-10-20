# gmail-agent

A proactive Gmail triage agent on Cloudflare Durable Objects. It polls your inbox, uses Jev to classify every email, archives the noise, pushes the urgent stuff to your phone, and learns from your feedback. Luna only summarises what survives.

Built on the same shape as the Durable News Agent: a durable agent, a trigger, and thin clients.

## How it works

```
alarm (every 15s, interval tunable) -> poll Gmail history
  -> Jev triage (category, importance, needs_action, urgent)   cheap, every email
  -> policy (archive / keep / alert)                           deterministic, explainable
  -> Luna summary                                              only kept and alerted mail
  -> Gmail modify (archive + label) / Pushover push
  -> feed card (why, undo, more/less)                          UI over WebSocket
```

- **One Durable Object per mailbox** (`Mailbox`): Gmail tokens, feed, taste weights and rules live in its SQLite. `PiHarness` runs the chat agent in the same object.
- **Tuning loop:** thumbs on cards move sender weights; chat messages call tools (`update_settings`, `set_weight`, `add_rule`, `remove_rule`, `unarchive`, `recent_decisions`); rules and recent verdicts are fed into the next Jev call.
- **Safe by default:** the OAuth scope is `gmail.modify` (no delete, no send). Archive is reversible and labelled `Agent/Archived`. Low Jev confidence, protected categories (personal, security) and "needs action" are never archived.
- **Login is allowlisted:** only addresses in the `ALLOWED_EMAILS` secret can sign in. It's a secret so your address never lands in the repo. The allowlist is re-checked on every request, so removing an address revokes access immediately.

## Setup

1. Create a Google OAuth client (web). Redirect URI: `https://gmail-agent.<your-subdomain>.workers.dev/auth/callback` (and `http://localhost:8787/auth/callback` for dev). Enable the Gmail API.
2. Get an OpenAI API key (platform.openai.com). The app calls OpenAI directly with it. It doesn't use Cloudflare AI or AI Gateway, so there's no Cloudflare AI billing. `CHAT_MODEL` and `SUMMARY_MODEL` in `wrangler.jsonc` pick the model (default `gpt-6-luna`).
3. Set secrets:
   ```bash
   wrangler secret put ALLOWED_EMAILS      # your Google account; comma-separate for several. Unset = nobody can sign in
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put SESSION_SECRET      # long random string
   wrangler secret put TYPESAFE_API_KEY    # Jev
   wrangler secret put OPENAI_API_KEY      # your own OpenAI key
   ```
   Optional, for phone pushes (without them, notifications show in the app's bell menu only):
   ```bash
   wrangler secret put PUSHOVER_APP_TOKEN  # from pushover.net/apps/build
   wrangler secret put PUSHOVER_USER_KEY   # your user key, top right of pushover.net
   ```
4. `npm run deploy`, open the site, sign in, and the first poll runs within 15 seconds.

Local dev: copy `.dev.vars.example` to `.dev.vars`, then `npm run build:web && npm run dev`.

## How often it checks

By default every 10 minutes (`POLL_SECONDS` in `wrangler.jsonc`, 600). Change it any time from the Thresholds panel (every 1 minute to every hour) or by asking the chat agent. A check with nothing new is one cheap Gmail request and makes no AI calls. There is no fixed heartbeat: the object sets one wake-up for exactly when the next poll or digest is due, so at 10 minutes it wakes about 6 times an hour and is idle in between.

## Offline demo (fake mode)

Everything external has a local stand-in, so you can run and demo the whole loop with no Google account, no Jev key and no model access:

```bash
npm run dev:fake        # http://localhost:8787, then click Sign in
```

| Real | Fake |
|---|---|
| Gmail | `FakeGmail` in the Durable Object's own SQLite: labels, history feed, sent mail |
| Jev | `src/fake-jev.ts`: deterministic keyword heuristics answering the same typed questions |
| Luna (OpenAI) | canned summaries and digests |
| Chat model | a scripted model on the **real** `PiHarness`, so tool calls really execute |
| Pushover | not needed; notifications are recorded in the app and shown in the bell menu and on the Demo tab |
| Time | a demo clock you can fast-forward (learning waits 30 minutes, "ignored" takes 3 days) |

The **Demo** tab delivers sample emails (`src/fake-data.ts`), runs poll, learn and digest, moves the clock, and lets you pretend to read, star, rescue, archive or reply to mail so the learning loop has something to observe.

`FAKE_MODE` is refused on any host except `localhost`, so it can't be switched on in production by accident. The fake Jev is a stand-in for plumbing and demos. It says nothing about how well the real Jev will classify your mail.

## Tests

```bash
npm test                # everything
npm run test:unit       # weights, policy, fake Jev scenarios (instant)
npm run test:pipeline   # starts the real Worker + Durable Object in fake mode and drives it over HTTP
```

The pipeline tests cover polling, every action, weights and guards, categories growing, votes and undo, the digest schedule, learning proposals, cost tracking, and the chat agent running real tools.

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | Routes, Google OAuth, session gate |
| `src/mailbox.ts` | The Durable Object: poll loop, pipeline, tools, API |
| `src/jev.ts` | Jev client and the triage question set |
| `src/policy.ts` | Archive / keep / alert decision (unit tested) |
| `src/gmail.ts` | Gmail REST client and the `MailApi` interface |
| `src/fake*.ts` | Offline stand-ins and sample data |
| `web/` | React + Vite UI: feed left, chat right |
