# Discord Codex Bridge

Standalone Discord bridge for talking to local Codex from a Discord server.

## What It Does

- Accepts `!codex ...` commands in Discord
- Accepts direct bot mentions like `@codex ...`
- Sends the request to local `codex exec`
- Replies back in Discord with the Codex result
- Stores short-term working context per channel or thread
- Rolls older conversation into a compact long-term summary
- Stores semantic memory for stable rules, preferences, and project facts
- Stores episodic memory for important completed tasks
- Dynamically shrinks or expands injected memory based on request complexity
- Keeps local job history on disk
- Shows stage reactions and presence while the bot is working

## Project Layout

```text
discord-codex-bridge/
  bridge-data/
    archive/
    conversations/
    inbox/
    jobs/
    logs/
    memory/
    outbox/
  scripts/
    setup-codex-runtime.ps1
    start-bridge.ps1
    stop-bridge.ps1
  src/
```

## Setup

1. Copy `.env.example` to `.env`
2. Fill `DISCORD_BOT_TOKEN`
3. Keep `RUNNER_MODE=codex`
4. Install dependencies

```powershell
cmd /c npm.cmd install
```

## Start

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1
```

Stop:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-bridge.ps1
```

## Discord Usage

Examples:

```text
!codex Help me review the latest changes in D:\codex
```

```text
@codex Summarize what is in D:\codex
```

Status:

```text
!codex status
```

Help:

```text
!codex help
```

## Memory Layers

- Working memory: recent turns plus the current request
- Compressed conversation memory: rolling summary of older turns
- Semantic memory: stable user rules, preferences, and project facts
- Episodic memory: important past tasks and their outcomes
- Dynamic prompt budget: small talk gets a tiny memory slice, coding tasks get a larger one

## Discord Status Signals

- `👀`: command received
- `🧠`: loading or compacting context and memory
- `🤔`: Codex is actively working
- `✅`: request completed
- `❌`: request failed

The bot presence also changes between ready, loading context, and working.

## Runner Modes

Default:

```text
RUNNER_MODE=codex
```

Optional values:

- `codex`: call local Codex CLI directly
- `queue`: write tasks to disk and wait for a manual/local worker reply
- `openai`: direct model replies through OpenAI API

## Codex Runtime

This repository does not commit `codex.exe` into Git.

Instead, `scripts/setup-codex-runtime.ps1` copies these files from the local
Codex installation into a private runtime folder before startup:

- `codex.exe`
- `codex-command-runner.exe`

Destination:

```text
vendor/codex-runtime/
```

## Useful Environment Variables

- `DISCORD_BOT_TOKEN`
- `DISCORD_ALLOWED_CHANNELS`
- `DISCORD_COMMAND_PREFIX`
- `RUNNER_MODE`
- `WORKSPACE_ROOT`
- `CHAT_HISTORY_LIMIT`
- `CHAT_SUMMARY_CHAR_LIMIT`
- `CHAT_TRANSCRIPT_MAX_TURNS`
- `CHAT_ARCHIVE_BATCH_SIZE`
- `CHAT_TURN_CHAR_LIMIT`
- `MEMORY_FACT_RECALL_LIMIT`
- `MEMORY_EPISODE_RECALL_LIMIT`
- `MEMORY_PINNED_FACT_LIMIT`
- `MEMORY_MAX_FACTS_PER_TARGET`
- `MEMORY_MAX_EPISODES_PER_SCOPE`
- `PROMPT_MEMORY_CHAR_BUDGET`
- `PROMPT_MEMORY_MIN_CHAR_BUDGET`
- `PROMPT_MEMORY_MAX_CHAR_BUDGET`
- `CODEX_CLI_PATH`
- `CODEX_MODEL`
- `CODEX_TIMEOUT_MS`

## Notes

- `bridge-data/` contains local runtime state
- `.env` is ignored by Git
- `vendor/codex-runtime/` is ignored by Git
