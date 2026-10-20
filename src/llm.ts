import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Env } from "./env";

/**
 * The OpenAI API, called directly with your own key (the OPENAI_API_KEY secret).
 * One Models registry serves both the chat agent and the summary/digest calls, so they share
 * the same provider, catalog pricing and cost accounting.
 */
export function createLlm(env: Env) {
  const credentials = new InMemoryCredentialStore();
  // Resolved once, before the first request. Without a key, requests fail with a clear auth error.
  const ready: Promise<unknown> = env.OPENAI_API_KEY
    ? credentials.modify("openai", async () => ({ type: "api_key" as const, key: env.OPENAI_API_KEY! }))
    : Promise.resolve();

  const models = createModels({ credentials });
  models.setProvider(openaiProvider());

  return {
    models,
    ready,
    /** A model from pi-ai's OpenAI catalog, e.g. "gpt-6-luna". */
    model(id: string) {
      const m = models.getModel("openai", id);
      if (!m) throw new Error(`Unknown OpenAI model '${id}'. Check CHAT_MODEL and SUMMARY_MODEL in wrangler.jsonc.`);
      return m;
    },
  };
}

export type Llm = ReturnType<typeof createLlm>;
