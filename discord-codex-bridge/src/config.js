import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

/**
 * Read and normalize bridge configuration from environment variables.
 *
 * Input:
 *   options {object}: Loader options such as requireDiscordToken.
 * Output:
 *   {object} config: Runtime configuration for Discord, storage, and runner
 *   selection. Paths are absolute strings.
 */
export function loadConfig(options = {}) {
  const requireDiscordToken = options.requireDiscordToken !== false;
  const rootDir = path.resolve(process.cwd());
  const dataDir = path.join(rootDir, "bridge-data");

  return {
    rootDir,
    dataDir,
    inboxDir: path.join(dataDir, "inbox"),
    outboxDir: path.join(dataDir, "outbox"),
    archiveDir: path.join(dataDir, "archive"),
    jobsDir: path.join(dataDir, "jobs"),
    conversationsDir: path.join(dataDir, "conversations"),
    discordToken: requireDiscordToken ? requireEnv("DISCORD_BOT_TOKEN") : (process.env.DISCORD_BOT_TOKEN || "").trim(),
    commandPrefix: process.env.DISCORD_COMMAND_PREFIX || "!codex",
    allowedChannelIds: splitCsv(process.env.DISCORD_ALLOWED_CHANNELS || ""),
    runnerMode: (process.env.RUNNER_MODE || "queue").trim().toLowerCase(),
    workspaceRoot: process.env.WORKSPACE_ROOT || "D:/codex",
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    openAiModel: process.env.OPENAI_MODEL || "",
    outboxPollMs: Number(process.env.OUTBOX_POLL_MS || 4000),
    chatHistoryLimit: Number(process.env.CHAT_HISTORY_LIMIT || 12),
    codexCliPath:
      process.env.CODEX_CLI_PATH ||
      path.join(rootDir, "vendor", "codex-runtime", "codex.exe"),
    codexModel: process.env.CODEX_MODEL || "",
    codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 900000),
  };
}

/**
 * Require one environment variable to exist.
 *
 * Input:
 *   name {string}: Environment variable name.
 * Output:
 *   {string}: Trimmed environment variable value.
 */
function requireEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Split one CSV environment variable into a clean string array.
 *
 * Input:
 *   value {string}: Comma-separated string.
 * Output:
 *   {string[]}: Trimmed non-empty values.
 */
function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
