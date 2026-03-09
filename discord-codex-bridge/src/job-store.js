import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Ensure all runtime storage directories exist.
 *
 * Input:
 *   config {object}: Bridge configuration with absolute directory paths.
 * Output:
 *   {Promise<void>}
 */
export async function ensureStore(config) {
  await Promise.all([
    fs.mkdir(config.memoryDir, { recursive: true }),
    fs.mkdir(config.memoryUsersDir, { recursive: true }),
    fs.mkdir(config.memoryScopesDir, { recursive: true }),
    fs.mkdir(config.inboxDir, { recursive: true }),
    fs.mkdir(config.outboxDir, { recursive: true }),
    fs.mkdir(config.archiveDir, { recursive: true }),
    fs.mkdir(config.jobsDir, { recursive: true }),
    fs.mkdir(config.conversationsDir, { recursive: true }),
  ]);
}

/**
 * Create one persisted job from a Discord message.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   payload {object}: Task prompt and Discord metadata.
 * Output:
 *   {Promise<object>}: Persisted job record.
 */
export async function createJob(config, payload) {
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    prompt: payload.prompt,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    source: {
      channelId: payload.channelId,
      guildId: payload.guildId,
      authorId: payload.authorId,
      authorTag: payload.authorTag,
      messageId: payload.messageId,
      messageUrl: payload.messageUrl,
    },
    workspaceRoot: payload.workspaceRoot,
    runnerMode: payload.runnerMode,
    conversationScopeId: payload.conversationScopeId || "",
    conversationSummary: String(payload.conversationSummary || ""),
    conversationTurns: Array.isArray(payload.conversationTurns)
      ? payload.conversationTurns
      : [],
    memoryFacts: Array.isArray(payload.memoryFacts) ? payload.memoryFacts : [],
    memoryEpisodes: Array.isArray(payload.memoryEpisodes)
      ? payload.memoryEpisodes
      : [],
    resultSummary: "",
  };

  await writeJob(config, job);
  await writeInboxPrompt(config, job);
  return job;
}

/**
 * Update one job in place with a partial patch object.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   jobId {string}: Job identifier.
 *   patch {object}: Fields to merge into the persisted job.
 * Output:
 *   {Promise<object>}: Updated job record.
 */
export async function updateJob(config, jobId, patch) {
  const job = await readJob(config, jobId);
  const nextJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeJob(config, nextJob);
  return nextJob;
}

/**
 * Read one persisted job from disk.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   jobId {string}: Job identifier.
 * Output:
 *   {Promise<object>}: Parsed job record.
 */
export async function readJob(config, jobId) {
  const raw = await fs.readFile(jobJsonPath(config, jobId), "utf8");
  return JSON.parse(raw);
}

/**
 * List recent jobs sorted by update time descending.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   limit {number}: Maximum number of jobs to return.
 * Output:
 *   {Promise<object[]>}: Recent job records.
 */
export async function listJobs(config, limit = 10) {
  const entries = await fs.readdir(config.jobsDir);
  const jobs = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = await fs.readFile(path.join(config.jobsDir, entry), "utf8");
    jobs.push(JSON.parse(raw));
  }

  return jobs
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/**
 * Write one manual completion file that the bot can pick up from outbox.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   jobId {string}: Job identifier.
 *   content {string}: Reply text to send back to Discord.
 * Output:
 *   {Promise<string>}: Absolute path to the outbox markdown file.
 */
export async function writeOutboxReply(config, jobId, content) {
  const filePath = outboxPath(config, jobId);
  await fs.writeFile(filePath, String(content || ""), "utf8");
  return filePath;
}

/**
 * Read and consume one outbox reply file, archiving it after use.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   jobId {string}: Job identifier from the filename.
 * Output:
 *   {Promise<string>}: Reply markdown content.
 */
export async function consumeOutboxReply(config, jobId) {
  const sourcePath = outboxPath(config, jobId);
  const content = await fs.readFile(sourcePath, "utf8");
  const archivePath = path.join(
    config.archiveDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${jobId}.md`,
  );
  await fs.rename(sourcePath, archivePath);
  return content;
}

/**
 * Return pending outbox job identifiers.
 *
 * Input:
 *   config {object}: Bridge configuration.
 * Output:
 *   {Promise<string[]>}: Job ids that have reply files waiting.
 */
export async function listPendingOutboxIds(config) {
  const entries = await fs.readdir(config.outboxDir);
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/u, ""));
}

/**
 * Build one absolute JSON path for a job record.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   jobId {string}: Job identifier.
 * Output:
 *   {string}: Absolute path to the JSON file.
 */
function jobJsonPath(config, jobId) {
  return path.join(config.jobsDir, `${jobId}.json`);
}

/**
 * Build one absolute markdown path for an outbox reply.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   jobId {string}: Job identifier.
 * Output:
 *   {string}: Absolute path to the outbox markdown file.
 */
function outboxPath(config, jobId) {
  return path.join(config.outboxDir, `${jobId}.md`);
}

/**
 * Persist one job record to the jobs directory.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   job {object}: Serializable job record.
 * Output:
 *   {Promise<void>}
 */
async function writeJob(config, job) {
  await fs.writeFile(jobJsonPath(config, job.id), JSON.stringify(job, null, 2), "utf8");
}

/**
 * Write one human-readable inbox task file for Codex or manual processing.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   job {object}: Persisted job record.
 * Output:
 *   {Promise<void>}
 */
async function writeInboxPrompt(config, job) {
  const filePath = path.join(config.inboxDir, `${job.id}.md`);
  const recentConversation = (job.conversationTurns || [])
    .map(
      (turn) =>
        `- [${turn.role || "user"}] ${turn.authorTag || "unknown"}: ${String(
          turn.content || "",
        )
          .replace(/\s+/g, " ")
          .trim()}`,
    )
    .join("\n");
  const memoryFacts = (job.memoryFacts || [])
    .map(
      (fact) =>
        `- [${fact.category || "fact"}] ${String(fact.text || "").trim()}`,
    )
    .join("\n");
  const memoryEpisodes = (job.memoryEpisodes || [])
    .map((episode) => {
      const parts = [
        `- ${String(episode.title || "episode").trim()}`,
        episode.resultSummary ? `  Result: ${String(episode.resultSummary).trim()}` : null,
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n");
  const content = [
    `# Job ${job.id}`,
    "",
    `- Status: ${job.status}`,
    `- Created: ${job.createdAt}`,
    `- Runner: ${job.runnerMode}`,
    `- Workspace: ${job.workspaceRoot}`,
    `- Discord Author: ${job.source.authorTag}`,
    `- Discord Message: ${job.source.messageUrl}`,
    job.conversationScopeId
      ? `- Conversation Scope: ${job.conversationScopeId}`
      : null,
    "",
    job.conversationSummary ? "## Older Conversation Summary" : null,
    job.conversationSummary ? "" : null,
    job.conversationSummary || null,
    job.conversationSummary ? "" : null,
    recentConversation ? "## Recent Conversation" : null,
    recentConversation ? "" : null,
    recentConversation || null,
    recentConversation ? "" : null,
    memoryFacts ? "## Semantic Memory" : null,
    memoryFacts ? "" : null,
    memoryFacts || null,
    memoryFacts ? "" : null,
    memoryEpisodes ? "## Episodic Memory" : null,
    memoryEpisodes ? "" : null,
    memoryEpisodes || null,
    memoryEpisodes ? "" : null,
    "## Prompt",
    "",
    job.prompt,
    "",
    "## Reply",
    "",
    `Write the final reply to bridge-data/outbox/${job.id}.md`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  await fs.writeFile(filePath, content, "utf8");
}
