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
    memoryDir: path.join(dataDir, "memory"),
    memoryUsersDir: path.join(dataDir, "memory", "users"),
    memoryScopesDir: path.join(dataDir, "memory", "scopes"),
    inboxDir: path.join(dataDir, "inbox"),
    outboxDir: path.join(dataDir, "outbox"),
    archiveDir: path.join(dataDir, "archive"),
    jobsDir: path.join(dataDir, "jobs"),
    conversationsDir: path.join(dataDir, "conversations"),
    discordToken: requireDiscordToken ? requireEnv("DISCORD_BOT_TOKEN") : (process.env.DISCORD_BOT_TOKEN || "").trim(),
    commandPrefix: process.env.DISCORD_COMMAND_PREFIX || "!codex",
    allowedChannelIds: splitCsv(process.env.DISCORD_ALLOWED_CHANNELS || ""),
    serverContextWindow: Number(process.env.DISCORD_SERVER_CONTEXT_WINDOW || 6),
    serverContextMaxAgeSec: Number(
      process.env.DISCORD_SERVER_CONTEXT_MAX_AGE_SEC || 300,
    ),
    runnerMode: (process.env.RUNNER_MODE || "queue").trim().toLowerCase(),
    workspaceRoot: process.env.WORKSPACE_ROOT || "D:/codex",
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    openAiModel: process.env.OPENAI_MODEL || "",
    outboxPollMs: Number(process.env.OUTBOX_POLL_MS || 4000),
    chatHistoryLimit: Number(process.env.CHAT_HISTORY_LIMIT || 12),
    chatSummaryCharLimit: Number(process.env.CHAT_SUMMARY_CHAR_LIMIT || 1200),
    chatTranscriptMaxTurns: Number(process.env.CHAT_TRANSCRIPT_MAX_TURNS || 24),
    chatArchiveBatchSize: Number(process.env.CHAT_ARCHIVE_BATCH_SIZE || 6),
    chatTurnCharLimit: Number(process.env.CHAT_TURN_CHAR_LIMIT || 4000),
    memoryFactRecallLimit: Number(process.env.MEMORY_FACT_RECALL_LIMIT || 6),
    memoryEpisodeRecallLimit: Number(process.env.MEMORY_EPISODE_RECALL_LIMIT || 4),
    memoryPinnedFactLimit: Number(process.env.MEMORY_PINNED_FACT_LIMIT || 4),
    memoryMaxFactsPerTarget: Number(process.env.MEMORY_MAX_FACTS_PER_TARGET || 120),
    memoryMaxEpisodesPerScope: Number(process.env.MEMORY_MAX_EPISODES_PER_SCOPE || 80),
    promptMemoryCharBudget: Number(process.env.PROMPT_MEMORY_CHAR_BUDGET || 2800),
    promptMemoryMinCharBudget: Number(process.env.PROMPT_MEMORY_MIN_CHAR_BUDGET || 500),
    promptMemoryMaxCharBudget: Number(process.env.PROMPT_MEMORY_MAX_CHAR_BUDGET || 4200),
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
