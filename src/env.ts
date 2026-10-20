import type { Mailbox } from "./mailbox";

export interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
  ASSETS: Fetcher;
  /** Secret. Comma-separated Google accounts allowed to sign in. Unset or empty means nobody can. */
  ALLOWED_EMAILS: string;
  /** Default for how often to check for new mail, in seconds. The in-app setting overrides it. */
  POLL_SECONDS?: string;
  SUMMARY_MODEL: string;
  CHAT_MODEL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  TYPESAFE_API_KEY: string;
  /** Secret. Your own OpenAI key, used directly for chat, summaries and digests. */
  OPENAI_API_KEY?: string;
  /** Pushover is optional. Without both of these, notifications are recorded in the app only. */
  PUSHOVER_APP_TOKEN?: string;
  PUSHOVER_USER_KEY?: string;
  /** optional: send to one device name instead of all of them */
  PUSHOVER_DEVICE?: string;
  /** "1" enables the offline demo: fake Gmail, Jev, models and push. Refused off localhost. */
  FAKE_MODE?: string;
}
