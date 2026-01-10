# Configuration (config.json)

This bot reads a JSON config file to decide which agent to run and how to build the command.

## Location
- Default: `~/.config/aipal/config.json`
- Or use `XDG_CONFIG_HOME` (default: `~/.config`)
- Or override with `BOT_CONFIG_PATH`

The file is also updated automatically when you use `/model` or `/thinking`.

## Schema (overview)
```json
{
  "model": "gpt-5.2",
  "thinking": "medium",
  "agent": "codex",
  "agents": {
    "codex": {
      "type": "codex",
      "cmd": "codex",
      "args": "--json --skip-git-repo-check",
      "template": "",
      "output": "codex-json",
      "session": { "strategy": "thread" },
      "label": "codex",
      "modelArg": "--model",
      "thinkingArg": "--thinking"
    }
  }
}
```

## Top-level fields
- `model`: default model name. Set via `/model <name>`.
- `thinking`: default thinking level. Set via `/thinking <level>`.
- `agent`: which agent entry to use from `agents`. If missing, falls back to `AGENT` env var, then `codex`.
- `agents`: object map of agent definitions. Keys are matched case-insensitively.

## Agent fields
### Required (at least one)
- `cmd`: binary or command to run.
- `template`: full template string.

If both are missing, the bot will error when that agent is selected.

### Optional
- `type`: `codex` or `generic`.
  - `codex`: builds `codex exec` commands and parses Codex JSON for thread ids.
  - `generic`: just runs the command and returns raw text.
- `args`: arguments appended to `cmd` (ignored if `template` is used).
- `template`: full command line. Supports placeholders:
  - `{prompt}`: final prompt (already shell-quoted)
  - `{session}`: resolved from `session.strategy`
  - `{model}`: model value (already shell-quoted)
  - `{thinking}`: thinking value (already shell-quoted)
- `output`: `codex-json` or `text`.
  - `codex-json` extracts `thread_id` + message text from Codex JSON.
  - `text` returns raw output.
- `session`: `{ "strategy": "thread" | "chat" }`
  - `thread`: uses Codex `thread_id` from JSON output
  - `chat`: uses the Telegram chat id
  - anything else: empty session string
- `label`: friendly name shown in `/start` reply.
- `modelArg`: flag used when `/model` is set and `{model}` is not present in the template.
- `thinkingArg`: flag used when `/thinking` is set and `{thinking}` is not present in the template.

## Resolution rules
- The selected agent is `agent` from config, else `AGENT`, else `codex`.
- If no JSON config exists, a built-in `codex` agent is used.
- If an agent name is not in the defaults but is defined in `agents`, it is treated as `generic`.
- When `template` is set, it fully controls the command:
  - if `{prompt}` is missing, the prompt is appended automatically
  - if `{model}` / `{thinking}` are missing, `modelArg` / `thinkingArg` are appended when set

## Examples
### Minimal Codex config
```json
{
  "agent": "codex",
  "agents": {
    "codex": {
      "type": "codex",
      "cmd": "codex",
      "args": "--json --skip-git-repo-check",
      "output": "codex-json",
      "session": { "strategy": "thread" }
    }
  }
}
```

### Generic CLI with template
```json
{
  "agent": "mycli",
  "agents": {
    "mycli": {
      "type": "generic",
      "template": "mycli --format text {prompt}",
      "output": "text",
      "session": { "strategy": "chat" }
    }
  }
}
```
