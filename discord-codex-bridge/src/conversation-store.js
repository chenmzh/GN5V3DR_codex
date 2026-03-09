import fs from "node:fs/promises";
import path from "node:path";

/**
 * Append one chat turn to the stored Discord conversation history.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope such as thread/channel id.
 *   turn {object}: Chat turn with role, authorTag, content, and timestamp.
 * Output:
 *   {Promise<object[]>}: Updated short-term transcript kept on disk.
 */
export async function appendConversationTurn(config, scopeId, turn) {
  const transcript = await readConversation(config, scopeId);
  const normalizedTurn = normalizeTurn(turn, config.chatTurnCharLimit);
  if (!normalizedTurn) {
    return transcript;
  }

  transcript.push(normalizedTurn);
  const { nextTranscript, nextSummary } = compactConversationState(
    config,
    transcript,
    await readConversationSummary(config, scopeId),
  );

  await Promise.all([
    writeConversation(config, scopeId, nextTranscript),
    writeConversationSummary(config, scopeId, nextSummary),
  ]);

  return nextTranscript;
}

/**
 * Read one stored Discord conversation transcript.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 * Output:
 *   {Promise<object[]>}: Ordered recent chat turn array.
 */
export async function readConversation(config, scopeId) {
  const filePath = conversationPath(config, scopeId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Return the most recent N turns from one stored conversation.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 *   limit {number}: Maximum number of turns to keep.
 * Output:
 *   {Promise<object[]>}: Most recent chat turn array.
 */
export async function readRecentConversation(config, scopeId, limit) {
  const transcript = await readConversation(config, scopeId);
  return transcript.slice(-safePositiveInt(limit, 0));
}

/**
 * Read both short-term and long-term conversation context for one scope.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 *   limit {number}: Maximum number of recent turns to keep verbatim.
 *   summaryCharLimit {number}: Maximum summary length for older turns.
 * Output:
 *   {Promise<object>}: Recent turns plus one compact older-history summary.
 */
export async function readConversationContext(
  config,
  scopeId,
  limit,
  summaryCharLimit,
) {
  const transcript = await readConversation(config, scopeId);
  const persistedSummary = await readConversationSummary(config, scopeId);
  const recentLimit = safePositiveInt(limit, 0);
  const recentTurns = transcript.slice(-recentLimit);
  const olderTurns = transcript.slice(
    0,
    Math.max(0, transcript.length - recentTurns.length),
  );

  return {
    recentTurns,
    summary: mergeSummaryText(
      persistedSummary,
      summarizeConversationTurns(olderTurns),
      summaryCharLimit,
    ),
  };
}

/**
 * Store one complete Discord conversation transcript.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 *   transcript {object[]}: Serializable chat turn array.
 * Output:
 *   {Promise<void>}
 */
export async function writeConversation(config, scopeId, transcript) {
  const filePath = conversationPath(config, scopeId);
  await fs.writeFile(filePath, JSON.stringify(transcript, null, 2), "utf8");
}

/**
 * Read the persisted long-term summary for one conversation scope.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 * Output:
 *   {Promise<string>}: Stored rolling summary text.
 */
export async function readConversationSummary(config, scopeId) {
  const filePath = conversationSummaryPath(config, scopeId);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/**
 * Store one rolling long-term summary for a conversation scope.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 *   summary {string}: Plain-text rolling summary.
 * Output:
 *   {Promise<void>}
 */
export async function writeConversationSummary(config, scopeId, summary) {
  const filePath = conversationSummaryPath(config, scopeId);
  await fs.writeFile(filePath, String(summary || ""), "utf8");
}

/**
 * Move older turns out of the short-term transcript into the rolling summary.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   transcript {object[]}: Current short-term transcript candidate.
 *   summary {string}: Existing rolling summary.
 * Output:
 *   {object}: Compact transcript plus updated summary.
 */
function compactConversationState(config, transcript, summary) {
  const maxTurns = safePositiveInt(config.chatTranscriptMaxTurns, 24);
  const archiveBatchSize = Math.min(
    maxTurns,
    safePositiveInt(config.chatArchiveBatchSize, 6),
  );
  let nextTranscript = transcript.slice();
  let nextSummary = String(summary || "");

  while (nextTranscript.length > maxTurns) {
    const overflow = nextTranscript.length - maxTurns;
    const archiveCount = Math.max(archiveBatchSize, overflow);
    const archivedTurns = nextTranscript.slice(0, archiveCount);
    nextTranscript = nextTranscript.slice(archiveCount);
    nextSummary = mergeSummaryText(
      nextSummary,
      summarizeConversationTurns(archivedTurns),
      config.chatSummaryCharLimit,
    );
  }

  return {
    nextTranscript,
    nextSummary,
  };
}

/**
 * Compress one set of turns into a plain-text summary block.
 *
 * Input:
 *   turns {object[]}: Conversation turns to compress.
 * Output:
 *   {string}: Compact multi-line summary text.
 */
function summarizeConversationTurns(turns) {
  return turns
    .map(formatSummaryLine)
    .filter(Boolean)
    .join("\n");
}

/**
 * Render one stored turn as a compact summary line.
 *
 * Input:
 *   turn {object}: Stored chat turn with role, authorTag, and content.
 * Output:
 *   {string}: One normalized summary line.
 */
function formatSummaryLine(turn) {
  const content = String(turn?.content || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!content) {
    return "";
  }

  const role = turn?.role || "user";
  const authorTag = turn?.authorTag || "unknown";
  const snippet =
    content.length > 180 ? `${content.slice(0, 177)}...` : content;
  return `- [${role}] ${authorTag}: ${snippet}`;
}

/**
 * Merge older summary text with newly archived lines and clamp total size.
 *
 * Input:
 *   existingSummary {string}: Previously stored rolling summary.
 *   newSummaryLines {string}: New archived lines to append.
 *   maxChars {number}: Maximum number of summary characters to keep.
 * Output:
 *   {string}: Clamped rolling summary text.
 */
function mergeSummaryText(existingSummary, newSummaryLines, maxChars) {
  const summaryLimit = safePositiveInt(maxChars, 0);
  const blocks = [String(existingSummary || "").trim(), String(newSummaryLines || "").trim()]
    .filter(Boolean);
  if (blocks.length === 0) {
    return "";
  }

  const merged = blocks.join("\n");
  if (summaryLimit === 0 || merged.length <= summaryLimit) {
    return merged;
  }

  return `...${merged.slice(-(summaryLimit - 3))}`;
}

/**
 * Normalize one turn before it is persisted.
 *
 * Input:
 *   turn {object}: Candidate chat turn.
 *   maxChars {number}: Maximum stored content length.
 * Output:
 *   {object|null}: Normalized turn or null when content is empty.
 */
function normalizeTurn(turn, maxChars) {
  const content = String(turn?.content || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!content) {
    return null;
  }

  const turnCharLimit = safePositiveInt(maxChars, 4000);
  return {
    role: String(turn?.role || "user"),
    authorTag: String(turn?.authorTag || "unknown"),
    content:
      content.length > turnCharLimit
        ? `${content.slice(0, turnCharLimit - 3)}...`
        : content,
    createdAt: String(turn?.createdAt || new Date().toISOString()),
    messageId: String(turn?.messageId || ""),
  };
}

/**
 * Build one absolute path for a conversation transcript JSON file.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 * Output:
 *   {string}: Absolute transcript file path.
 */
function conversationPath(config, scopeId) {
  return path.join(config.conversationsDir, `${scopeId}.json`);
}

/**
 * Build one absolute path for a conversation summary file.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 * Output:
 *   {string}: Absolute summary file path.
 */
function conversationSummaryPath(config, scopeId) {
  return path.join(config.conversationsDir, `${scopeId}.summary.txt`);
}

/**
 * Normalize a numeric configuration value into a safe positive integer.
 *
 * Input:
 *   value {unknown}: Candidate integer-like value.
 *   fallback {number}: Default value when parsing fails.
 * Output:
 *   {number}: Positive integer or zero.
 */
function safePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}
