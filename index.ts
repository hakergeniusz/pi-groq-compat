/**
 * pi-groq-compat — make pi's built-in `groq` provider actually work.
 *
 * Two problems, one extension:
 *
 * 1. Groq runs llama.cpp templates that only accept `role: "system"`. Pi's
 *    OpenAI-completions adapter sends `role: "developer"` unless the model's
 *    compat sets `supportsDeveloperRole: false`. With the flag unset, every
 *    qwen/gpt-oss request dies with:
 *
 *      Error 400: failed to template request: failed to render text output:
 *      minijinja: rendering failed: raise_exception: Unexpected message role.
 *
 *    Reproduce without pi:
 *      curl -H "Authorization: Bearer $GROQ_API_KEY" \
 *        https://api.groq.com/openai/v1/chat/completions \
 *        -d '{"model":"qwen/qwen3.8-27b","messages":[
 *              {"role":"developer","content":"hi"},{"role":"user","content":"hi"}]}'
 *    Same body with "system" → 200. (gpt-oss models on Groq DO accept
 *    "developer"; qwen does not. The flag is per-catalog-model, so this
 *    extension sets it on every groq model — harmless for gpt-oss.)
 *
 * 2. pi's generated groq catalog is stale: it lists llama-3.1-8b-instant /
 *    llama-3.3-70b-versatile / qwen3.6-27b (enterprise, absent from the free
 *    account's /models) and is missing allam-2-7b. This extension re-registers
 *    the provider with the live chat model set and verified metadata.
 *
 * What it does on load:
 *   - registers provider "groq" (baseUrl https://api.groq.com/openai/v1) with
 *     `compat.supportsDeveloperRole: false` on every model, so the adapter
 *     emits `system` prompts;
 *   - keeps context/maxTokens honest: gpt-oss 131072/65536, qwen3.8-27b
 *     131072/16384 (Groq docs), allam-2-7b 4096/2048 (probed against the API);
 *   - excludes models pi cannot drive: whisper/orpheus (audio endpoints),
 *     llama-prompt-guard classifiers (reject system messages), retired
 *     enterprise ids.
 *
 * `/groq-compat` commands:
 *   (no args)   status: registered models, active model, per-model compat flag
 *   refresh     re-read https://api.groq.com/openai/v1/models and re-register
 *               (picks up models Groq adds later)
 *   test        send a developer-role probe request to the active groq model
 *               and report OK/FAIL
 *
 * Auth is inherited from the built-in provider (env GROQ_API_KEY, or a key
 * stored for the groq provider) — this extension never handles keys.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const MODELS_URL = GROQ_BASE_URL + "/models";

interface ChatModelMeta {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input?: Array<"text" | "image">;
  /** Groq docs / probe-verified values. contextWindow for allam-2-7b probed:
   *  3500-word prompt OK, 4000-word → 400 "Please reduce the length". */
}

const MODEL_META: Record<string, ChatModelMeta> = {
  "openai/gpt-oss-120b": { contextWindow: 131072, maxTokens: 65536, reasoning: true },
  "openai/gpt-oss-20b": { contextWindow: 131072, maxTokens: 65536, reasoning: true },
  "openai/gpt-oss-safeguard-20b": { contextWindow: 131072, maxTokens: 65536, reasoning: true },
  "qwen/qwen3.8-27b": { contextWindow: 131072, maxTokens: 16384, reasoning: true },
  // No tool calling on Groq ("`tool calling` is not supported with this model"):
  // fine for plain chat, 400s in pi agent mode which always sends tools.
  "allam-2-7b": { contextWindow: 4096, maxTokens: 2048, reasoning: false },
};

/** Metadata for models Groq adds later: sane defaults, fixable via refresh. */
const DEFAULT_META: ChatModelMeta = { contextWindow: 131072, maxTokens: 16384, reasoning: false };

/**
 * Text classifiers: callable only with a single bare user message (no system
 * prompt), so pi (which always sends a system prompt) can never drive them.
 * Excluded intentionally. */
const CLASSIFIER_PATTERNS = [/^meta-llama\/llama-prompt-guard/];

/** Chat models NOT on /models: enterprise-only, 404 on the free tier. */
const RETIRED_PATTERNS = [/^llama-3\.1-8b-instant$/, /^llama-3\.3-70b-versatile$/, /^qwen\/qwen3\.6-27b$/];

/** Models on /models that are not usable chat-completions models. */
const NON_CHAT_PATTERNS = [...CLASSIFIER_PATTERNS, ...RETIRED_PATTERNS, /^whisper/, /^canopylabs/, /orpheus/];

function isChatModelId(id: string): boolean {
  return !NON_CHAT_PATTERNS.some((re) => re.test(id));
}

function groqApiKey(): string | undefined {
  return process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY_1;
}

function modelDefinitions(ids: string[]) {
  return ids.map((id) => {
    const meta = MODEL_META[id] ?? DEFAULT_META;
    return {
      id,
      name: id,
      api: "openai-completions" as const,
      reasoning: meta.reasoning,
      input: meta.input ?? (["text"] as Array<"text">),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: meta.contextWindow,
      maxTokens: meta.maxTokens,
      compat: {
        supportsDeveloperRole: false,
        supportsStrictMode: id.startsWith("openai/gpt-oss"),
        maxTokensField: "max_tokens" as const,
      },
    };
  });
}

function staticIds(): string[] {
  return Object.keys(MODEL_META);
}

async function fetchLiveChatModelIds(): Promise<string[]> {
  const key = groqApiKey();
  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = "Bearer " + key;
  const res = await fetch(MODELS_URL, { headers });
  if (!res.ok) throw new Error("GET " + MODELS_URL + " -> " + res.status);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? []).map((m) => m.id ?? "").filter((id) => id && isChatModelId(id));
  return Array.from(new Set([...ids, ...staticIds()])).sort();
}

function register(pi: ExtensionAPI, ids: string[]): void {
  pi.registerProvider("groq", {
    baseUrl: GROQ_BASE_URL,
    models: modelDefinitions(ids),
  });
}

export default function (pi: ExtensionAPI): void {
  // The generated catalog's llama entries are enterprise-only (not in the free
  // tier's /models), so the live chat set is the complete useful list. Live
  // fetch happens in /groq-compat refresh, not at load, to keep startup offline.
  try {
    register(pi, staticIds());
  } catch (e) {
    console.error("[groq-compat] failed to register patched groq provider:", e);
  }

  pi.registerCommand("groq-compat", {
    description: "Groq provider status/refresh/test (developer-role fix + live model sync)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const cmd = (args || "").trim().toLowerCase();
      const active = ctx.model;

      if (cmd === "refresh") {
        try {
          const ids = await fetchLiveChatModelIds();
          register(pi, ids);
          ctx.ui.notify(
            "groq-compat: registered " + ids.length + " live models, supportsDeveloperRole=false",
            "info"
          );
        } catch (e) {
          ctx.ui.notify("groq-compat refresh failed: " + (e as Error).message, "error");
        }
        return;
      }

      if (cmd === "test") {
        if (!active || active.provider !== "groq") {
          ctx.ui.notify("groq-compat test: active model is not a groq model", "warning");
          return;
        }
        const key = groqApiKey();
        if (!key) {
          ctx.ui.notify("groq-compat test: GROQ_API_KEY not set in this pane", "warning");
          return;
        }
        try {
          const res = await fetch(GROQ_BASE_URL + "/chat/completions", {
            method: "POST",
            headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: active.id,
              messages: [
                { role: "developer", content: "You are terse." },
                { role: "user", content: "ping" },
              ],
              max_tokens: 4,
            }),
          });
          const text = await res.text();
          ctx.ui.notify(
            res.ok
              ? "groq-compat: developer-role request accepted — fix is live (" + active.id + ")"
              : "groq-compat: request rejected — " + res.status + " " + text.slice(0, 160),
            res.ok ? "info" : "error"
          );
        } catch (e) {
          ctx.ui.notify("groq-compat test failed: " + (e as Error).message, "error");
        }
        return;
      }

      // status (default)
      const models = ctx.modelRegistry
        .getAll()
        .filter((m) => m.provider === "groq")
        .map((m) => m.id);
      const keyState = groqApiKey() ? "GROQ_API_KEY present" : "GROQ_API_KEY MISSING";
      const lines = [
        "groq-compat status — " + keyState,
        "active: " + (active ? active.provider + " / " + active.id : "none"),
        "registered groq models: " + (models.length ? models.join(", ") : staticIds().join(", ")),
        "compat: supportsDeveloperRole=false on all (pi sends role=system)",
        "/groq-compat refresh | test",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
