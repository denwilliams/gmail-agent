import { getAgentByName } from "agents";
import {
  clearCookie,
  exchangeCode,
  googleAuthUrl,
  idTokenClaims,
  isAllowed,
  readSession,
  sessionCookie,
  signSession,
} from "./auth";
import type { Env } from "./env";

export { Mailbox } from "./mailbox";

const STATE_COOKIE = "ga_oauth_state";

const mailbox = (env: Env) => getAgentByName(env.MAILBOX, "primary");

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Fake mode swaps Google, Jev, the models and push for local stand-ins and skips OAuth.
    // It must never be reachable from the internet, so it fails closed anywhere but localhost.
    const fake = env.FAKE_MODE === "1";
    if (fake && !isLocalHost(url.hostname)) {
      return new Response("FAKE_MODE is only allowed on localhost", { status: 500 });
    }

    if (fake && url.pathname === "/auth/login") {
      const email = env.ALLOWED_EMAILS.split(",")[0]!.trim();
      const stub = await mailbox(env);
      await stub.fetch("https://do/api/fake/start", { method: "POST", body: JSON.stringify({ account: email }) });
      return new Response(null, {
        status: 302,
        // plain http on localhost: Safari drops Secure cookies there
        headers: { location: "/", "set-cookie": sessionCookie(await signSession(env, email)).replace("; Secure", "") },
      });
    }

    if (url.pathname === "/auth/login") {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return new Response("Google sign-in isn't configured. Set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.", { status: 500 });
      }
      const state = crypto.randomUUID();
      return new Response(null, {
        status: 302,
        headers: {
          location: googleAuthUrl(env, url.origin, state),
          "set-cookie": `${STATE_COOKIE}=${state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    if (url.pathname === "/auth/callback") {
      const state = url.searchParams.get("state");
      const expected = req.headers.get("cookie")?.match(new RegExp(`${STATE_COOKIE}=([^;]+)`))?.[1];
      const code = url.searchParams.get("code");
      if (!code || !state || state !== expected) return new Response("Bad OAuth state", { status: 400 });

      const tokens = await exchangeCode(env, url.origin, code);
      const claims = idTokenClaims(tokens.id_token);
      // Allowlist gate: unknown accounts are rejected before anything is stored.
      if (!claims.email_verified || !isAllowed(env, claims.email)) {
        return new Response("This account is not allowed to use this app.", { status: 403 });
      }
      if (tokens.refresh_token) {
        const stub = await mailbox(env);
        await stub.fetch("https://do/api/internal/connect", {
          method: "POST",
          body: JSON.stringify({ email: claims.email, refreshToken: tokens.refresh_token }),
        });
      }
      const headers = new Headers({ location: "/" });
      headers.append("set-cookie", sessionCookie(await signSession(env, claims.email!)));
      headers.append("set-cookie", `${STATE_COOKIE}=; Path=/auth; Max-Age=0`);
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === "/auth/logout") {
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": clearCookie() } });
    }

    if (url.pathname === "/api/me") {
      const email = await readSession(env, req);
      return Response.json({ email });
    }

    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      if (!(await readSession(env, req))) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname.startsWith("/api/internal")) return new Response("Not found", { status: 404 });
      const stub = await mailbox(env);
      return stub.fetch(req);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
