# Aipal: Telegram Codex Bot

![Aipal](docs/assets/aipal.jpg)

Minimal Telegram bot that forwards messages to a local CLI agent (Codex by default). Each message is executed locally and the output is sent back to the chat.

## What it does
- Runs your configured CLI agent for every message
- Queues requests per chat to avoid overlapping runs
- Keeps Codex thread state when JSON output is detected
- Handles text, audio (via Parakeet), and images
- Supports `/model` and `/thinking` to tweak the agent at runtime

## Requirements
- Node.js 18+
- Agent CLI on PATH (default: `codex`)
- Audio (optional): `parakeet-mlx` + `ffmpeg`

## Quick start
```bash
git clone https://github.com/antoniolg/aipal.git
cd aipal
npm install
cp .env.example .env
```

1. Create a Telegram bot with BotFather and get the token.
2. Set `TELEGRAM_BOT_TOKEN` in `.env`.
3. Start the bot:

```bash
npm start
```

Open Telegram, send `/start`, then any message.

## Usage (Telegram)
- Text: send a message and get the agent response
- Audio: send a voice note or audio file (transcribed with Parakeet)
- Images: send a photo or image file (caption becomes the prompt)
- `/reset`: clear the chat session (drops the Codex thread id)
- `/model <name>`: set the model (persisted in `config.json`)
- `/thinking <level>`: set thinking level (persisted in `config.json`)

### Images in responses
If the agent generates an image, save it under `IMAGE_DIR` and reply with:
```
[[image:/absolute/path]]
```
The bot will send the image back to Telegram.

## Configuration
Environment variables live in `.env`.

**Bot**
- `TELEGRAM_BOT_TOKEN`: required

**Config file**
- `BOT_CONFIG_PATH`: JSON config path (default: `~/.config/aipal/config.json` or `$XDG_CONFIG_HOME/aipal/config.json`)
- `AGENT`: default agent key when the JSON config does not specify one

**Agent command**
- `CODEX_CMD`: default `codex`
- `CODEX_ARGS`: default `--json --skip-git-repo-check`
- `CODEX_TEMPLATE`: optional full template; supports `{prompt}`, `{session}`, `{model}`, `{thinking}`

**Audio**
- `PARAKEET_CMD`: default `parakeet-mlx`
- `PARAKEET_MODEL`: optional model name
- `PARAKEET_TIMEOUT_MS`: transcription timeout

**Images**
- `IMAGE_DIR`: folder for inbound/outbound images (default: OS temp under `aipal/images`)
- `IMAGE_TTL_HOURS`: auto-delete images older than this (default: 24, set `0` to disable)
- `IMAGE_CLEANUP_INTERVAL_MS`: cleanup interval (default: 3600000 / 1h)

See `docs/configuration.md` for the JSON schema and full examples.

## Agent config (JSON)
Create the JSON config file to define which agent to run and how to invoke it.

Example:
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
      "modelArg": "--model",
      "thinkingArg": "--thinking"
    },
    "cloud-code": {
      "type": "generic",
      "cmd": "cloud-code",
      "args": "",
      "template": "cloud-code {prompt}",
      "output": "text",
      "session": { "strategy": "chat" }
    }
  }
}
```

## Template examples
```
CODEX_TEMPLATE=codex exec --json {prompt}
```
```
CODEX_TEMPLATE=codex exec --json --model gpt-5.2 {prompt}
```
```
# With resume (use {session} if you want to control the format)
CODEX_TEMPLATE=codex exec resume {session} --json {prompt}
```

## Security notes
This bot executes local commands on your machine. Run it only on trusted hardware, keep the bot private, and avoid sharing the token. There is no built-in allowlist: anyone who can message the bot can execute the configured command.

## How it works
- Builds a shell command with a base64-encoded prompt to avoid quoting issues
- Executes the command locally via `bash -lc`
- If the agent outputs Codex-style JSON, stores `thread_id` and uses `exec resume`
- Audio is downloaded, transcribed, then forwarded as text
- Images are downloaded into `IMAGE_DIR` and included in the prompt

## Troubleshooting
- `ENOENT parakeet-mlx`: install `parakeet-mlx` and ensure it is on PATH.
- `Error processing response.`: check the agent command (`CODEX_CMD` / `CODEX_TEMPLATE`) and that it is executable.
- Telegram `ECONNRESET`: usually transient network, retry.

## License
MIT. See `LICENSE`.
