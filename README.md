# pi-model-picker

A categorized, keyboard-driven model selector extension for the [pi coding agent](https://github.com/badlogic/pi-mono).

Instead of a flat searchable list, models are grouped by provider in horizontal tabs. Switch categories with `Tab` or arrow keys, type to filter within a category, and navigate with `↑`/`↓`.

## Preview

```
╔═════════════════════════════════════════════════════════════════╗
║  Select Model                                                   ║
╠═════════════════════════════════════════════════════════════════╣
║◀  Anthropic │ Google │ Cliproxyapi │ Ollama ▶                   ║
║─────────────────────────────────────────────────────────────────║
║  Search: claude_                                                ║
║─────────────────────────────────────────────────────────────────║
║▶ Claude Sonnet 4.6 ●                         200k  thinking     ║
║  Claude Opus 4.5                             200k  thinking     ║
║  Claude Haiku 3.5                            200k  vision       ║
║─────────────────────────────────────────────────────────────────║
║  ↑↓ navigate  ·  Tab/← → category  ·  enter select  ·  esc     ║
╚═════════════════════════════════════════════════════════════════╝
```

- **Active model** shown with `●` and highlighted in green
- **Favorite models** shown with `★`; press `Ctrl+F` to toggle favorites
- **Hidden models** shown in the `Hidden` tab with `◌`; press `Ctrl+H` to hide/unhide models
- **Context window** shown as `200k`, `1M`, etc.
- **Capability tags**: `thinking` (extended reasoning), `vision` (image input)
- **Search** filters by model name or id within the current category
- **Search term preserved** per category — switch away and back, your query is still there
- **Wraparound navigation** — `↑` on the first item jumps to the last, and vice versa
- **Dynamic provider discovery** — auto-register models from any OpenAI-compatible `/models` endpoint via `pi-model-picker.json` (see below)

## Dynamic provider discovery

Besides picking from configured models, the extension can discover models from
any OpenAI-compatible provider at startup. Configure providers once in a
`pi-model-picker.json` file and every model returned by their `/models` endpoint
is registered automatically (no hand-listing in `models.json`).

The file is looked up, first match wins, in:

1. `~/.pi/agent/extensions/pi-model-picker/config.json` (global, in extension folder)
2. `./.pi/extensions/pi-model-picker.json` (project)
3. `~/.pi/agent/extensions/pi-model-picker.json` (global)
4. `./.pi/pi-model-picker.json`
5. `~/.pi/pi-model-picker.json`

```json
{
  "modelProviders": [
    {
      "name": "bedrock-mantle",
      "baseUrl": "https://bedrock-mantle.us-east-1.api.aws/v1",
      "api": "openai-completions",
      "apiKey": "!op read op://Private/bedrock-envs/production/AWS_BEARER_TOKEN_BEDROCK",
      "authHeader": true,
      "filter": "",
      "reasoningFilter": "kimi|glm|gpt-5|qwen3|claude|deepseek|minimax",
      "defaults": { "contextWindow": 262144, "maxTokens": 32000, "input": ["text"] }
    }
  ]
}
```

Per-provider fields:

| Field | Meaning |
|-------|---------|
| `name` | Provider id shown as a picker category |
| `baseUrl` | Base URL; `/models` (or `modelsPath`) is appended for discovery |
| `api` | Pi API type (default `openai-completions`) |
| `apiKey` | `!command` (runs shell, uses stdout), `$VAR`/`${VAR}` (env), or a literal |
| `authHeader` | Send `Authorization: Bearer` on chat requests (default `true`) |
| `headers` | Extra request headers |
| `filter` | Regex on model id; only matching ids are registered (empty = all) |
| `reasoningFilter` | Regex on model id; matches get `reasoning: true` |
| `modelsPath` | Discovery path (default `/models`) |
| `defaults` | Fallback `contextWindow` / `maxTokens` / `input` / `cost` / `reasoning` |
| `cacheTtlSeconds` | Reuse discovered results this long (default 12h) |

Discovery results and the resolved key are cached under the OS temp dir at
`$TMPDIR/pi-model-picker/discovery-cache.json` (mode `0600`) so `apiKey`
commands and network calls only run when the cache is older than the TTL. A
failed refresh falls back to the stale cache instead of dropping the provider.

If a provider can't be discovered at all (e.g. a missing/invalid `apiKey` giving
a `401`, or an unreachable endpoint), it's skipped and a warning is shown when
the session starts — `model-picker: provider skipped — <name>: <reason>` — so a
silently-missing provider is easy to diagnose. Details also go to stderr
(visible via `pi --list-models`).


## Install

### Via npm (recommended)

```bash
npm install -g pi-model-picker
pi-model-picker
```

Restart pi after installation.

### Via pi package manager

```bash
pi install npm:pi-model-picker
```

### Via git

```bash
pi install git:github.com/rilham97/pi-model-picker
```

### Manual

```bash
git clone https://github.com/rilham97/pi-model-picker.git \
  ~/.pi/agent/extensions/model-picker
```

Restart pi.

## Usage

| Trigger | Description |
|---------|-------------|
| `/models` | Open the categorized picker |
| `Ctrl+Shift+M` | Keyboard shortcut |

> **Note:** `/model` is a built-in pi command and cannot be overridden. Use `/models` (with an `s`) for this picker. The built-in `/model` (flat search) continues to work as normal.

## Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate models (wraps around) |
| `Tab` / `Shift+Tab` | Switch provider category |
| `←` / `→` | Switch category (when search field is empty) |
| `←` / `→` | Move cursor in search field (when field has text) |
| Type | Filter models in the current category |
| `Ctrl+F` | Toggle favorite for highlighted model |
| `Ctrl+H` | Hide/unhide highlighted model |
| `Enter` | Select highlighted model |
| `Esc` | Cancel |

## How it works

The picker calls `modelRegistry.refresh()` then `modelRegistry.getAvailable()` — the same data source as pi's built-in `/model` command. Only models with auth configured (API key or OAuth) are shown. Models are grouped by their `provider` field and sorted alphabetically within each category, with the currently active model's provider appearing first.

## Uninstall

```bash
pi remove npm:pi-model-picker
rm -rf ~/.pi/agent/extensions/model-picker
```

## License

MIT
