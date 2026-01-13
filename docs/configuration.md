# Configuration (config.json)

This bot stores a minimal JSON config with the values set by `/model` and `/thinking`.

## Location
- `~/.config/aipal/config.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/config.json`

## Schema
```json
{
  "model": "gpt-5.2",
  "thinking": "medium"
}
```

## Fields
- `model`: default model name.
- `thinking`: default reasoning effort (used as `model_reasoning_effort` in Codex).

If the file is missing, both values are unset and the bot uses agent defaults.
