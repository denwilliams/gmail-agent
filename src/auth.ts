import type { Env } from "./env";

const COOKIE = "ga_session";
const SESSION_TTL_S = 60 * 60 * 24 * 14;
const enc = new TextEncoder();

export function isAllowed(env: Env, email: string | undefined | null): boolean {
  if (!email) return false;
  const allowed = env.ALLOWED_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(env: Env, email: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = btoa(JSON.stringify({ email, exp }));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

/** Returns the email for a valid, unexpired, still-allowlisted session. */
export async function readSession(env: Env, req: Request): Promise<string | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const raw = cookie
    .split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, payload))) return null;
  try {
    const { email, exp } = JSON.parse(atob(payload)) as { email: string; exp: number };
    if (exp < Date.now() / 1000) return null;
    // Re-check the allowlist on every request so removing someone revokes access.
    return isAllowed(env, email) ? email : null;
  } catch {
    return null;
  }
}

export function sessionCookie(value: string, maxAge = SESSION_TTL_S): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export const clearCookie = () => sessionCookie("", 0);

const SCOPES = [
  "openid",
  "email",
  // modify = read, label, archive. No delete, no send.
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ");

export function googleAuthUrl(env: Env, origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token: string;
}

export async function exchangeCode(env: Env, origin: string, code: string): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return res.json();
}

/** The id_token comes straight from Google's token endpoint over TLS, so decoding is sufficient. */
export function idTokenClaims(idToken: string): { email?: string; email_verified?: boolean } {
  const part = idToken.split(".")[1] ?? "";
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}

export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return res.json();
}
