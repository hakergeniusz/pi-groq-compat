// Runtime smoke test for pi-groq-compat's load path: stub the ExtensionAPI
// surface the extension touches and assert what it registers.
import activate from "./index.ts";

const registered: Record<string, unknown> = {};
const commands: string[] = [];

const pi = {
  registerProvider: (id: string, config: unknown) => {
    registered[id] = config;
  },
  registerCommand: (name: string) => {
    commands.push(name);
  },
} as never;

activate(pi);

const groq = registered["groq"] as {
  baseUrl: string;
  models: Array<{
    id: string;
    api: string;
    contextWindow: number;
    maxTokens: number;
    compat: { supportsDeveloperRole: boolean; maxTokensField?: string };
  }>;
};

if (!groq) throw new Error("groq provider not registered");
if (groq.baseUrl !== "https://api.groq.com/openai/v1") throw new Error("bad baseUrl");
const bad = groq.models.filter((m) => m.compat.supportsDeveloperRole !== false);
if (bad.length) throw new Error("models missing supportsDeveloperRole=false: " + bad.map((m) => m.id));
for (const m of groq.models) {
  if (m.api !== "openai-completions") throw new Error(m.id + ": wrong api " + m.api);
  if (!(m.contextWindow > 0 && m.maxTokens > 0)) throw new Error(m.id + ": bad token limits");
}
console.log(
  "OK — groq registered with " +
    groq.models.length +
    " models, commands: " +
    commands.join(",") +
    "\n" +
    groq.models
      .map((m) => "  " + m.id + " ctx=" + m.contextWindow + " max=" + m.maxTokens + " devRole=false")
      .join("\n")
);
