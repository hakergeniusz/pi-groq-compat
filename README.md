# pi-groq-compat

Makes pi's built-in `groq` provider usable on Groq's llama.cpp-backed models.

## Problem

`qwen/qwen3.8-27b` (and most non-gpt-oss Groq models) reject any request whose
messages use `role: "developer"`:

```
Error 400: {"message":"failed to template request: failed to render text output:
minijinja: rendering failed: raise_exception: Unexpected message role.",
"type":"invalid_request_error"}
```

Pi's OpenAI-completions adapter sends `developer` for system prompts unless the
model catalog entry sets `compat.supportsDeveloperRole: false`. Groq's template
only knows `system`. (`openai/gpt-oss-*` on Groq do accept `developer`, which
is why the bug is model-specific and easy to miss.)

Minimal reproduction:

```bash
curl -H "Authorization: Bearer $GROQ_API_KEY" \
  https://api.groq.com/openai/v1/chat/completions \
  -d '{"model":"qwen/qwen3.8-27b","messages":[
        {"role":"developer","content":"hi"},
        {"role":"user","content":"hi"}]}'   # 400
# same body with "system" instead of "developer" -> 200
```

## What this extension does

On load it re-registers provider `groq`
(`https://api.groq.com/openai/v1`) with a clean model list where every entry has:

- `compat.supportsDeveloperRole: false` — the actual fix; pi then emits
  `role: "system"` and Groq templates render.
- `compat.maxTokensField: "max_tokens"` — Groq has no `max_completion_tokens`.
- verified `contextWindow` / `maxTokens` (Groq docs + API probes; `allam-2-7b`'s
  ~4k context was probed: 3500-word prompt OK, 4000-word prompt 400s).

It also fixes catalog drift: pi's generated groq catalog lists enterprise-only
models that are absent from the free tier's `/models` and is missing
`allam-2-7b` and the `llama-prompt-guard-2` classifiers.

Audio models (`whisper-*`, `canopylabs/orpheus-*`) are intentionally excluded —
they use `/audio/*` endpoints, not chat completions.

## Commands

```
/groq-compat           # status: models, active model, compat state, key presence
/groq-compat refresh   # re-fetch the live /models list and re-register
/groq-compat test      # send a developer-role probe to the active groq model
```

Model notes (verified against the API on the free tier):

- `qwen/qwen3.8-27b`, `openai/gpt-oss-*`: full agent use, work.
- `allam-2-7b`: no tool calling ("`tool calling` is not supported with this
  model"), so it 400s in pi agent mode; usable via direct API calls only.
  Kept in the catalog since plain-chat use (e.g. other pi modes) still works.
- `meta-llama/llama-prompt-guard-2-*`: excluded — classifiers that reject any
  system message.
- `whisper-*`, `canopylabs/orpheus-*`: excluded — audio endpoints.
- Enterprise ids from the generated catalog (`llama-3.1-8b-instant`,
  `llama-3.3-70b-versatile`, `qwen/qwen3.6-27b`): excluded — not in the free
  tier's `/models`.

## Install

The project dir is symlinked into pi's extension directory, same as the other
pi extensions on this machine:

```bash
ln -s ~/projects/pi-groq-compat ~/.pi/agent/extensions/pi-groq-compat
```

Auth is inherited from the built-in groq provider: this extension never reads,
stores, or transmits keys. Set `GROQ_API_KEY` in the environment or store a key
for the `groq` provider as usual.

For running two keys with automatic failover on 429/401, use the
`pi-multi-account` extension with a `groq` entry in
`~/.pi/agent/multi-account.json` (its schema carries the same
`compat.supportsDeveloperRole: false`).

## Typecheck

```bash
cd ~/projects/pi-groq-compat && bun run typecheck
```
