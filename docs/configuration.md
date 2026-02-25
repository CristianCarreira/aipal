# Configuration (config.json + soul.md + tools.md + memory.md + cron.json + memory state)

This bot stores a minimal JSON config with the values set by `/agent`.

## Location
- `~/.config/aipal/config.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/config.json`

## Schema
```json
{
  "agent": "codex",
  "models": {
    "codex": "gpt-5"
  },
  "cronChatId": 123456789
}
```

## Fields
- `agent`: which CLI to run (`codex`, `claude`, `gemini`, or `opencode`).
- `models` (optional): a map of agent id → model id, set via `/model` and cleared per-agent via `/model reset`.
- `cronChatId` (optional): Telegram chat id used for cron job messages. You can get it from `/cron chatid`.

## Agent Overrides file (optional)
When you use `/agent <name>` inside a Telegram Topic, the bot stores an override for that specific topic in:
- `~/.config/aipal/agent-overrides.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/agent-overrides.json`

Schema:
```json
{
  "chatId:topicId": "agentId"
}
```

## Bootstrap files (optional)
When present, these files are injected into the very first prompt of a new conversation (no active session/thread) in this order:
1. `soul.md`
2. `tools.md`
3. `memory.md`

## Memory file (optional)
If `memory.md` exists alongside `config.json`, its contents are injected during bootstrap (after `soul.md` and `tools.md`).

Location:
- `~/.config/aipal/memory.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory.md`

## Automatic memory capture
Every conversation is captured automatically into per-thread JSONL files:

- `~/.config/aipal/memory/threads/*.jsonl`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/threads/*.jsonl`

The key format is `chatId:topicId:agentId`, so multiple agents can write memory in parallel without sharing raw logs.

An SQLite index is also maintained automatically:
- `~/.config/aipal/memory/index.sqlite`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/index.sqlite`

Curated memory state is stored in:
- `~/.config/aipal/memory/state.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/state.json`

Environment knobs:
- `AIPAL_MEMORY_CURATE_EVERY`: auto-curate memory after N new captured events (default: `20`).
- `AIPAL_MEMORY_RETRIEVAL_LIMIT`: maximum number of retrieved memory lines injected per request (default: `5`).
- `AIPAL_THREAD_ROTATION_TURNS`: rotate (reset) the agent thread after N turns to limit accumulated context. `0` = disabled (default). Recommended: `20`-`30` for long conversations. When the thread rotates, the bot re-injects bootstrap context (soul, tools, memory) so the agent stays informed.

Retrieval currently mixes scopes (`same-thread`, `same-topic`, `same-chat`, `global`) so prompts can include both local continuity and useful cross-topic memory when available.

## Soul file (optional)
If `soul.md` exists alongside `config.json`, its contents are injected first during bootstrap (before `tools.md` and `memory.md`).

Location:
- `~/.config/aipal/soul.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/soul.md`

## Tools file (optional)
If `tools.md` exists alongside `config.json`, its contents are injected during bootstrap after `soul.md` and before `memory.md`.

Location:
- `~/.config/aipal/tools.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/tools.md`

## Cron jobs file (optional)
Cron jobs live in a separate file:
- `~/.config/aipal/cron.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/cron.json`

Schema:
```json
{
  "jobs": [
    {
      "id": "daily-summary",
      "enabled": true,
      "cron": "0 9 * * *",
      "timezone": "Europe/Madrid",
      "prompt": "Dame un resumen del día con mis tareas pendientes."
    }
  ]
}
```

Notes:
- Jobs are only scheduled when `cronChatId` is set in `config.json`.
- Use `/cron reload` after editing `cron.json` to apply changes without restarting the bot.

## Token usage tracking

The bot estimates token consumption for every agent interaction (~4 chars/token) and tracks daily totals.

### `/usage` command
Shows estimated token consumption for the current day:
```
Token usage (2025-06-15):
  Estimated: 12,450 tokens (input: 8,200 / output: 4,250)
  Messages: 23
  Budget: 12,450 / 100,000 (12.5%)
  ████░░░░░░ 12.5%
```

If no budget is configured, the budget line and progress bar are omitted.

### Environment knobs
- `AIPAL_TOKEN_BUDGET_DAILY`: daily token budget. `0` = no limit (default), only tracks usage. When set to a positive number, the bot sends proactive Telegram alerts when consumption crosses the following thresholds: **25%, 50%, 75%, 85%, 95%**. Each alert is sent only once per day.

### Persistence
Usage data is stored in:
- `~/.config/aipal/usage.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/usage.json`

The file resets automatically when the day changes.
