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
 *   {Promise<object[]>}: Full updated conversation transcript.
 */
export async function appendConversationTurn(config, scopeId, turn) {
  const transcript = await readConversation(config, scopeId);
  transcript.push(turn);
  await writeConversation(config, scopeId, transcript);
  return transcript;
}

/**
 * Read one stored Discord conversation transcript.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   scopeId {string}: Stable conversation scope identifier.
 * Output:
 *   {Promise<object[]>}: Ordered chat turn array.
 */
export async function readConversation(config, scopeId) {
  const filePath = conversationPath(config, scopeId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
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
  return transcript.slice(-limit);
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
