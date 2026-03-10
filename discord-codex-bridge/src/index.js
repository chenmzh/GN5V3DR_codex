import fs from "node:fs/promises";
import path from "node:path";
import {
  ActivityType,
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { loadConfig } from "./config.js";
import { chunkText } from "./chunk-text.js";
import {
  appendConversationTurn,
  readConversationContext,
} from "./conversation-store.js";
import {
  readRelevantMemories,
  rememberCompletedTask,
  updateMemoriesFromUserTurn,
} from "./memory-store.js";
import {
  consumeOutboxReply,
  createJob,
  ensureStore,
  listJobs,
  listPendingOutboxIds,
  readJob,
  updateJob,
} from "./job-store.js";
import { runJob } from "./runners/index.js";

const DISCORD_ATTACHMENTS_BLOCK_PATTERN =
  /```discord-attachments\s*\r?\n([\s\S]*?)```/giu;
const DISCORD_MAX_FILES_PER_MESSAGE = 10;

const STAGE_REACTIONS = {
  received: "👀",
  context: "🧠",
  thinking: "🤔",
  success: "✅",
  error: "❌",
};

/**
 * Start the Discord bridge bot and the outbox polling loop.
 *
 * Input:
 *   None. Configuration comes from .env and process.env.
 * Output:
 *   {Promise<void>}: Long-running bot process.
 */
async function main() {
  const config = loadConfig();
  await ensureStore(config);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  const context = {
    client,
    config,
    activeJobs: 0,
  };

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bridge logged in as ${readyClient.user.tag}`);
    syncPresence(context, "ready");
    startOutboxPoller(context);
  });

  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    console.warn(`Discord shard ${shardId} disconnected: ${closeEvent.code}`);
  });

  client.on(Events.ShardResume, (replayedEvents, shardId) => {
    console.log(
      `Discord shard ${shardId} resumed after replaying ${replayedEvents} events.`,
    );
    syncPresence(context, context.activeJobs > 0 ? "thinking" : "ready");
  });

  client.on(Events.Error, (error) => {
    console.error("Discord client error:", error);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(context, message);
    } catch (error) {
      console.error(error);
      if (!message.author.bot) {
        await setMessageState(message, "error");
        await message.reply(`Bridge error: ${error.message}`);
      }
    }
  });

  await client.login(config.discordToken);
}

/**
 * Handle one inbound Discord message that may contain a bridge command.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   message {import("discord.js").Message}: Discord message event.
 * Output:
 *   {Promise<void>}
 */
async function handleMessage(context, message) {
  if (message.author.bot) {
    return;
  }
  if (!isAllowedMessage(context.config, message)) {
    return;
  }

  const request = await resolveCommandInput(context, message);
  if (request.commandText === null) {
    return;
  }

  const remainder = request.commandText.trim();
  if (!remainder || remainder === "help") {
    await replyInChunks(
      message,
      [
        `用法: ${context.config.commandPrefix} <任务描述>`,
        `状态: ${context.config.commandPrefix} status`,
        `私信自己: ${context.config.commandPrefix} dm <内容>`,
        `帮助: ${context.config.commandPrefix} help`,
      ].join("\n"),
    );
    return;
  }

  if (remainder === "status") {
    await replyInChunks(message, formatStatus(await listJobs(context.config, 5)));
    return;
  }

  const dmContent = parseDirectMessageCommand(remainder);
  if (dmContent !== null) {
    await sendDirectMessageToAuthor(context, message, dmContent);
    return;
  }

  await setMessageState(message, "received");
  context.activeJobs += 1;
  syncPresence(context, "context");
  const keepAlive = startThinkingHeartbeat(message);

  try {
    const conversationScopeId = getConversationScopeId(message);
    const createdAt = new Date().toISOString();

    await setMessageState(message, "context");

    const conversationContext = await readConversationContext(
      context.config,
      conversationScopeId,
      context.config.chatHistoryLimit,
      context.config.chatSummaryCharLimit,
    );

    await appendConversationTurn(context.config, conversationScopeId, {
      role: "user",
      authorTag: message.author.tag,
      content: remainder,
      createdAt,
      messageId: message.id,
    });

    await updateMemoriesFromUserTurn(context.config, {
      scopeId: conversationScopeId,
      authorId: message.author.id,
      authorTag: message.author.tag,
      content: remainder,
      createdAt,
      messageId: message.id,
    });

    const memoryContext = await readRelevantMemories(context.config, {
      scopeId: conversationScopeId,
      authorId: message.author.id,
      query: remainder,
    });

    const job = await createJob(context.config, {
      prompt: remainder,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      authorTag: message.author.tag,
      messageId: message.id,
      messageUrl: message.url,
      workspaceRoot: context.config.workspaceRoot,
      runnerMode: context.config.runnerMode,
      conversationScopeId,
      conversationSummary: conversationContext.summary,
      conversationTurns: conversationContext.recentTurns,
      serverContextTurns: request.serverContextTurns,
      memoryFacts: memoryContext.facts,
      memoryEpisodes: memoryContext.episodes,
    });

    await updateJob(context.config, job.id, { status: "running" });
    await setMessageState(message, "thinking");
    syncPresence(context, "thinking");

    const result = await runJob(context, job);
    const replyPayload = await buildDiscordReplyPayload(
      job.workspaceRoot,
      result.reply,
    );
    const finalJob = await updateJob(context.config, job.id, {
      status: result.status,
      resultSummary: summarizeDiscordReply(replyPayload),
    });

    await replyInChunks(message, replyPayload.text, replyPayload.attachments);
    await appendConversationTurn(context.config, conversationScopeId, {
      role: "assistant",
      authorTag: context.client.user?.tag || "codex",
      content: formatStoredAssistantReply(replyPayload),
      createdAt: new Date().toISOString(),
    });

    await rememberCompletedTask(context.config, {
      scopeId: conversationScopeId,
      prompt: remainder,
      resultSummary: summarizeDiscordReply(replyPayload),
      createdAt: new Date().toISOString(),
      authorTag: message.author.tag,
    });

    await setMessageState(message, "success");

    if (finalJob.status === "queued") {
      return;
    }
  } catch (error) {
    await setMessageState(message, "error");
    throw error;
  } finally {
    stopThinkingHeartbeat(keepAlive);
    context.activeJobs = Math.max(0, context.activeJobs - 1);
    syncPresence(context, context.activeJobs > 0 ? "thinking" : "ready");
  }
}

/**
 * Start one timer that watches bridge-data/outbox for completed replies.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 * Output:
 *   {void}
 */
function startOutboxPoller(context) {
  setInterval(async () => {
    try {
      const pendingIds = await listPendingOutboxIds(context.config);
      for (const jobId of pendingIds) {
        try {
          await deliverOutboxReply(context, jobId);
        } catch (error) {
          console.error(`Failed delivering outbox reply for ${jobId}:`, error);
          await markOutboxJobFailed(context, jobId, error);
        }
      }
    } catch (error) {
      console.error("Outbox poller failed:", error);
    }
  }, context.config.outboxPollMs);
}

/**
 * Deliver one completed outbox reply back to the original Discord channel.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   jobId {string}: Job identifier.
 * Output:
 *   {Promise<void>}
 */
async function deliverOutboxReply(context, jobId) {
  const job = await readJob(context.config, jobId);
  if (!isSnowflake(job.source.channelId)) {
    throw new Error(
      `Invalid Discord channel id for job ${jobId}: ${job.source.channelId}`,
    );
  }
  const channel = await context.client.channels.fetch(job.source.channelId);
  if (!channel || !channel.isTextBased()) {
    await updateJob(context.config, jobId, {
      status: "failed",
      resultSummary: "Original Discord channel is no longer available.",
    });
    return;
  }

  const reply = await consumeOutboxReply(context.config, jobId);
  const replyPayload = await buildDiscordReplyPayload(job.workspaceRoot, reply);
  const deliveredText = [`Task ${jobId} completed.`, replyPayload.text]
    .filter(Boolean)
    .join("\n\n");
  await sendChannelInChunks(channel, deliveredText, replyPayload.attachments);
  await updateJob(context.config, jobId, {
    status: "completed",
    resultSummary: summarizeDiscordReply(replyPayload),
  });
}

/**
 * Resolve one inbound Discord message into a runnable bridge request.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   message {import("discord.js").Message}: Discord message event.
 * Output:
 *   {Promise<object>}: Parsed command text plus nearby server context.
 */
async function resolveCommandInput(context, message) {
  if (isDirectMessageChannel(message)) {
    return {
      commandText: String(message.content || "").trim() || null,
      serverContextTurns: [],
    };
  }

  const serverContextTurns = await readServerContextTurns(context, message);
  const directCommandText = extractDirectCommandText(context, message);
  if (directCommandText !== null) {
    return {
      commandText: directCommandText,
      serverContextTurns,
    };
  }

  const content = String(message.content || "").trim();
  if (!content) {
    return {
      commandText: null,
      serverContextTurns: [],
    };
  }

  if (isServerContextFollowUp(context, message, serverContextTurns)) {
    return {
      commandText: content,
      serverContextTurns,
    };
  }

  return {
    commandText: null,
    serverContextTurns: [],
  };
}

/**
 * Extract one supported command body from either a prefix or a bot mention.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   message {import("discord.js").Message}: Discord message event.
 * Output:
 *   {string|null}: Command body without the prefix/mention, or null when
 *   the message is not meant for the bot.
 */
function extractDirectCommandText(context, message) {
  const content = String(message.content || "").trim();
  if (!content) {
    return null;
  }

  if (content.startsWith(context.config.commandPrefix)) {
    return content.slice(context.config.commandPrefix.length).trim();
  }

  const botId = context.client.user?.id;
  if (!botId) {
    return null;
  }

  const mentionForms = [`<@${botId}>`, `<@!${botId}>`];
  for (const mention of mentionForms) {
    if (content.includes(mention)) {
      return content.replace(mention, " ").replace(/\s+/gu, " ").trim();
    }
  }

  const botRoleMentions = getBotRoleMentions(message);
  for (const mention of botRoleMentions) {
    if (content.includes(mention)) {
      return content.replace(mention, " ").replace(/\s+/gu, " ").trim();
    }
  }

  return null;
}

/**
 * Read one bounded slice of nearby server messages for follow-up inference.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   message {import("discord.js").Message}: Current Discord message event.
 * Output:
 *   {Promise<object[]>}: Ordered nearby-message list from the same channel.
 */
async function readServerContextTurns(context, message) {
  const windowSize = safePositiveInt(context.config.serverContextWindow, 0);
  if (windowSize === 0 || !message.channel?.messages?.fetch) {
    return [];
  }

  const collected = new Map();
  const referenceMessage = await readReferencedMessage(message);
  if (referenceMessage) {
    const normalizedReference = normalizeServerContextTurn(
      context,
      referenceMessage,
      true,
    );
    if (normalizedReference) {
      collected.set(normalizedReference.messageId, normalizedReference);
    }
  }

  try {
    const fetchedMessages = await message.channel.messages.fetch({
      limit: windowSize,
      before: message.id,
    });
    const orderedMessages = [...fetchedMessages.values()].sort(
      (left, right) => left.createdTimestamp - right.createdTimestamp,
    );

    for (const priorMessage of orderedMessages) {
      const normalizedTurn = normalizeServerContextTurn(
        context,
        priorMessage,
        false,
        message.createdTimestamp,
      );
      if (!normalizedTurn || collected.has(normalizedTurn.messageId)) {
        continue;
      }
      collected.set(normalizedTurn.messageId, normalizedTurn);
    }
  } catch (error) {
    console.warn("Failed reading nearby server context:", error.message);
  }

  return [...collected.values()].sort((left, right) =>
    String(left.createdAt || "").localeCompare(String(right.createdAt || "")),
  );
}

/**
 * Read the referenced Discord message when the current message is a reply.
 *
 * Input:
 *   message {import("discord.js").Message}: Current Discord message event.
 * Output:
 *   {Promise<import("discord.js").Message|null>}: Referenced message or null.
 */
async function readReferencedMessage(message) {
  if (!message.reference?.messageId || !message.fetchReference) {
    return null;
  }

  try {
    return await message.fetchReference();
  } catch (error) {
    console.warn("Failed reading reply target:", error.message);
    return null;
  }
}

/**
 * Normalize one nearby Discord message into a compact prompt-safe context turn.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   sourceMessage {import("discord.js").Message}: Nearby Discord message.
 *   fromReference {boolean}: True when loaded through reply-reference lookup.
 *   currentTimestamp {number}: Timestamp of the live user message.
 * Output:
 *   {object|null}: Serializable context turn or null when filtered out.
 */
function normalizeServerContextTurn(
  context,
  sourceMessage,
  fromReference,
  currentTimestamp = Date.now(),
) {
  const content = String(sourceMessage?.content || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!content) {
    return null;
  }

  const maxAgeMs = safePositiveInt(context.config.serverContextMaxAgeSec, 0) * 1000;
  const sourceTimestamp = Number(sourceMessage.createdTimestamp || 0);
  const ageMs = Math.max(0, Number(currentTimestamp || Date.now()) - sourceTimestamp);
  if (!fromReference && maxAgeMs > 0 && ageMs > maxAgeMs) {
    return null;
  }

  const mentionsBot = extractDirectCommandText(context, sourceMessage) !== null;
  const botUserId = context.client.user?.id || "";
  const isBotMessage = sourceMessage.author?.id === botUserId;

  return {
    messageId: String(sourceMessage.id || ""),
    authorId: String(sourceMessage.author?.id || ""),
    authorTag:
      sourceMessage.author?.tag ||
      sourceMessage.author?.username ||
      "unknown",
    content: content.length > 280 ? `${content.slice(0, 277)}...` : content,
    createdAt: sourceMessage.createdAt
      ? sourceMessage.createdAt.toISOString()
      : new Date(sourceTimestamp || Date.now()).toISOString(),
    isBotMessage,
    mentionsBot,
    fromReference: Boolean(fromReference),
  };
}

/**
 * Decide whether the current message should inherit the nearby server context.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   message {import("discord.js").Message}: Current Discord message event.
 *   serverContextTurns {object[]}: Ordered nearby-message context window.
 * Output:
 *   {boolean}: True when the message is a follow-up aimed at the bot.
 */
function isServerContextFollowUp(context, message, serverContextTurns) {
  if (!Array.isArray(serverContextTurns) || serverContextTurns.length === 0) {
    return false;
  }

  const botUserId = context.client.user?.id || "";
  const currentAuthorId = String(message.author?.id || "");

  for (let index = serverContextTurns.length - 1; index >= 0; index -= 1) {
    const anchorTurn = serverContextTurns[index];
    if (!isServerContextAnchor(anchorTurn)) {
      continue;
    }
    if (!canAnchorApplyToAuthor(anchorTurn, currentAuthorId, botUserId)) {
      continue;
    }

    const turnsAfterAnchor = serverContextTurns.slice(index + 1);
    const isClosedWindow = turnsAfterAnchor.every((turn) => {
      return turn.authorId === currentAuthorId || turn.authorId === botUserId;
    });
    if (isClosedWindow) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether one nearby message is strong enough to anchor bot follow-up.
 *
 * Input:
 *   turn {object}: One normalized nearby server context turn.
 * Output:
 *   {boolean}: True when the turn explicitly involved the bot.
 */
function isServerContextAnchor(turn) {
  return Boolean(turn?.isBotMessage || turn?.mentionsBot);
}

/**
 * Check whether one anchor message belongs to the same ongoing user-bot thread.
 *
 * Input:
 *   anchorTurn {object}: One normalized nearby server context turn.
 *   authorId {string}: Current Discord author id.
 *   botUserId {string}: Current bot user id.
 * Output:
 *   {boolean}: True when the anchor can be reused for this author.
 */
function canAnchorApplyToAuthor(anchorTurn, authorId, botUserId) {
  if (anchorTurn.authorId === botUserId) {
    return true;
  }
  return anchorTurn.authorId === authorId;
}

/**
 * Keep Discord typing status alive while the bot is working.
 *
 * Input:
 *   message {import("discord.js").Message}: Trigger message.
 * Output:
 *   {NodeJS.Timeout|null}: Interval handle used to refresh typing state.
 */
function startThinkingHeartbeat(message) {
  if (!message.channel?.sendTyping) {
    return null;
  }

  void safeSendTyping(message);
  return setInterval(() => {
    void safeSendTyping(message);
  }, 8000);
}

/**
 * Stop one active typing heartbeat interval.
 *
 * Input:
 *   timer {NodeJS.Timeout|null}: Interval handle returned by
 *   startThinkingHeartbeat.
 * Output:
 *   {void}
 */
function stopThinkingHeartbeat(timer) {
  if (timer) {
    clearInterval(timer);
  }
}

/**
 * Send one best-effort Discord typing signal.
 *
 * Input:
 *   message {import("discord.js").Message}: Trigger message.
 * Output:
 *   {Promise<void>}
 */
async function safeSendTyping(message) {
  try {
    await message.channel.sendTyping();
  } catch (error) {
    console.warn("Failed to send typing indicator:", error.message);
  }
}

/**
 * Reflect one processing stage back onto the trigger message with reactions.
 *
 * Input:
 *   message {import("discord.js").Message}: Trigger message.
 *   state {"received"|"context"|"thinking"|"success"|"error"}:
 *   Desired message stage.
 * Output:
 *   {Promise<void>}
 */
async function setMessageState(message, state) {
  try {
    const desiredEmoji = STAGE_REACTIONS[state] || null;
    const stageEmojis = Object.values(STAGE_REACTIONS);

    for (const emoji of stageEmojis) {
      if (emoji === desiredEmoji) {
        await ensureReaction(message, emoji);
      } else {
        await removeReaction(message, emoji);
      }
    }
  } catch (error) {
    console.warn("Failed updating message reactions:", error.message);
  }
}

/**
 * Ensure one reaction exists on a Discord message.
 *
 * Input:
 *   message {import("discord.js").Message}: Target message.
 *   emoji {string}: Emoji to add.
 * Output:
 *   {Promise<void>}
 */
async function ensureReaction(message, emoji) {
  const hasReaction = message.reactions.cache.some(
    (reaction) => reaction.emoji.name === emoji,
  );
  if (!hasReaction) {
    await message.react(emoji);
  }
}

/**
 * Remove the bot's own reaction from a Discord message when present.
 *
 * Input:
 *   message {import("discord.js").Message}: Target message.
 *   emoji {string}: Emoji to remove.
 * Output:
 *   {Promise<void>}
 */
async function removeReaction(message, emoji) {
  const reaction = message.reactions.cache.find(
    (entry) => entry.emoji.name === emoji,
  );
  if (!reaction) {
    return;
  }

  const userId = message.client.user?.id;
  if (!userId) {
    return;
  }

  await reaction.users.remove(userId);
}

/**
 * Reply to one Discord message with safe chunking.
 *
 * Input:
 *   message {import("discord.js").Message}: Discord message to reply to.
 *   text {string}: Long reply text.
 *   attachments {AttachmentBuilder[]}: Files to upload.
 * Output:
 *   {Promise<void>}
 */
async function replyInChunks(message, text, attachments = []) {
  await sendChunkedDiscordPayload(
    (payload) => message.reply(payload),
    (payload) => message.channel.send(payload),
    text,
    attachments,
  );
}

/**
 * Send one channel message with safe text chunking and optional file uploads.
 *
 * Input:
 *   channel {import("discord.js").TextBasedChannel}: Discord channel target.
 *   text {string}: Long reply text.
 *   attachments {AttachmentBuilder[]}: Files to upload.
 * Output:
 *   {Promise<void>}
 */
async function sendChannelInChunks(channel, text, attachments = []) {
  await sendChunkedDiscordPayload(
    (payload) => channel.send(payload),
    (payload) => channel.send(payload),
    text,
    attachments,
  );
}

/**
 * Send one Discord reply stream with text chunking and attachment batching.
 *
 * Input:
 *   sendFirst {(payload: object) => Promise<unknown>}: First-message sender.
 *   sendNext {(payload: object) => Promise<unknown>}: Follow-up sender.
 *   text {string}: Visible reply text.
 *   attachments {AttachmentBuilder[]}: Files to upload.
 * Output:
 *   {Promise<void>}
 */
async function sendChunkedDiscordPayload(
  sendFirst,
  sendNext,
  text,
  attachments = [],
) {
  const normalizedText = String(text || "").trim();
  const chunks = normalizedText
    ? chunkText(normalizedText)
    : attachments.length > 0
      ? []
      : ["(empty response)"];
  const attachmentGroups = chunkAttachments(attachments);
  const firstPayload = {};

  if (chunks.length > 0) {
    firstPayload.content = chunks[0];
  }
  if (attachmentGroups.length > 0) {
    firstPayload.files = attachmentGroups[0];
  }
  if (Object.keys(firstPayload).length === 0) {
    firstPayload.content = "(empty response)";
  }

  await sendFirst(firstPayload);

  for (let index = 1; index < chunks.length; index += 1) {
    await sendNext({ content: chunks[index] });
  }

  for (
    let groupIndex = attachmentGroups.length > 0 ? 1 : 0;
    groupIndex < attachmentGroups.length;
    groupIndex += 1
  ) {
    await sendNext({ files: attachmentGroups[groupIndex] });
  }
}

/**
 * Parse one assistant reply into visible text plus existing local files.
 *
 * Input:
 *   workspaceRoot {string}: Base directory for relative attachment paths.
 *   rawText {string}: Raw assistant reply or outbox markdown content.
 * Output:
 *   {Promise<object>}: Clean text plus validated Discord attachments.
 */
async function buildDiscordReplyPayload(workspaceRoot, rawText) {
  const parsedReply = parseDiscordAttachmentBlocks(rawText);
  const warnings = [];
  const attachments = [];
  const seenPaths = new Set();

  for (const rawPath of parsedReply.attachmentPaths) {
    const resolvedPath = resolveAttachmentPath(workspaceRoot, rawPath);
    if (!resolvedPath || seenPaths.has(resolvedPath)) {
      continue;
    }
    seenPaths.add(resolvedPath);

    try {
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        warnings.push(`'${rawPath}' is not a regular file.`);
        continue;
      }
      attachments.push(
        new AttachmentBuilder(resolvedPath, {
          name: path.basename(resolvedPath),
        }),
      );
    } catch (error) {
      warnings.push(`'${rawPath}' could not be read (${error.message}).`);
    }
  }

  const warningText =
    warnings.length > 0
      ? ["Failed file attachments:", ...warnings.map((item) => `- ${item}`)].join(
          "\n",
        )
      : "";
  const text = [parsedReply.text, warningText].filter(Boolean).join("\n\n").trim();

  return {
    text,
    attachments,
    attachmentCount: attachments.length,
  };
}

/**
 * Remove attachment code blocks and collect one file path per non-empty line.
 *
 * Input:
 *   rawText {string}: Assistant reply before Discord post-processing.
 * Output:
 *   {object}: Visible text and raw attachment path list.
 */
function parseDiscordAttachmentBlocks(rawText) {
  const attachmentPaths = [];
  const strippedText = String(rawText || "").replace(
    DISCORD_ATTACHMENTS_BLOCK_PATTERN,
    (_, blockContent) => {
      const lines = String(blockContent || "")
        .split(/\r?\n/u)
        .map((line) => stripQuotedPath(line.trim()))
        .filter((line) => line && !line.startsWith("#"));
      attachmentPaths.push(...lines);
      return "";
    },
  );

  return {
    text: strippedText.replace(/\n{3,}/gu, "\n\n").trim(),
    attachmentPaths,
  };
}

/**
 * Normalize one raw path line by removing matching wrapping quotes.
 *
 * Input:
 *   rawPath {string}: Attachment path line from the reply block.
 * Output:
 *   {string}: Clean path string.
 */
function stripQuotedPath(rawPath) {
  const normalized = String(rawPath || "").trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith("\"") && normalized.endsWith("\"")) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

/**
 * Resolve one attachment path against the job workspace when needed.
 *
 * Input:
 *   workspaceRoot {string}: Job workspace root.
 *   rawPath {string}: Absolute or relative path string.
 * Output:
 *   {string}: Absolute normalized file path.
 */
function resolveAttachmentPath(workspaceRoot, rawPath) {
  const normalized = stripQuotedPath(rawPath);
  if (!normalized) {
    return "";
  }
  return path.normalize(
    path.isAbsolute(normalized)
      ? normalized
      : path.resolve(workspaceRoot || process.cwd(), normalized),
  );
}

/**
 * Split one attachment list into Discord-safe message batches.
 *
 * Input:
 *   attachments {AttachmentBuilder[]}: Files to upload.
 * Output:
 *   {AttachmentBuilder[][]}: Ordered file groups with at most 10 items each.
 */
function chunkAttachments(attachments) {
  const groups = [];
  for (
    let index = 0;
    index < attachments.length;
    index += DISCORD_MAX_FILES_PER_MESSAGE
  ) {
    groups.push(attachments.slice(index, index + DISCORD_MAX_FILES_PER_MESSAGE));
  }
  return groups;
}

/**
 * Build one compact stored transcript line for assistant replies with files.
 *
 * Input:
 *   replyPayload {object}: Visible text plus attachment metadata.
 * Output:
 *   {string}: Conversation-store safe assistant content.
 */
function formatStoredAssistantReply(replyPayload) {
  const normalizedText = String(replyPayload?.text || "").trim();
  if (replyPayload?.attachmentCount > 0) {
    const attachmentTag = `\n\n[Attached ${replyPayload.attachmentCount} file(s)]`;
    return normalizedText ? `${normalizedText}${attachmentTag}` : attachmentTag.trim();
  }
  return normalizedText || "(empty response)";
}

/**
 * Build one short job summary string from the visible Discord reply payload.
 *
 * Input:
 *   replyPayload {object}: Visible text plus attachment metadata.
 * Output:
 *   {string}: Bounded summary for job storage and memory.
 */
function summarizeDiscordReply(replyPayload) {
  const summaryText = String(replyPayload?.text || "").trim();
  const attachmentNote =
    replyPayload?.attachmentCount > 0
      ? ` [attachments: ${replyPayload.attachmentCount}]`
      : "";
  const combined = `${summaryText || "(attachment-only reply)"}${attachmentNote}`;
  return combined.slice(0, 500);
}

/**
 * Parse one self-DM command from the bridge command body.
 *
 * Input:
 *   commandText {string}: Command body after the prefix or mention.
 * Output:
 *   {string|null}: DM payload text, or null when this is not a DM command.
 */
function parseDirectMessageCommand(commandText) {
  const normalized = String(commandText || "").trim();
  const lowered = normalized.toLowerCase();
  const prefixes = ["dm", "私信"];
  const matchedPrefix = prefixes.find((prefix) => {
    if (!lowered.startsWith(prefix.toLowerCase())) {
      return false;
    }

    if (normalized.length === prefix.length) {
      return true;
    }

    const nextChar = normalized[prefix.length];
    return /\s/u.test(nextChar);
  });

  if (!matchedPrefix) {
    return null;
  }

  if (normalized.length === matchedPrefix.length) {
    return "";
  }

  return normalized.slice(matchedPrefix.length + 1).trim();
}

/**
 * Send one direct message back to the user who triggered the bridge command.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   message {import("discord.js").Message}: Trigger Discord message.
 *   content {string}: DM payload text.
 * Output:
 *   {Promise<void>}
 */
async function sendDirectMessageToAuthor(context, message, content) {
  if (!content) {
    await replyInChunks(
      message,
      `用法: ${context.config.commandPrefix} dm <要发到你私信里的内容>`,
    );
    return;
  }

  try {
    const dmChannel = await message.author.createDM();
    for (const chunk of chunkText(content)) {
      await dmChannel.send(chunk);
    }

    await replyInChunks(
      message,
      "已尝试发送私信。如果没收到，请检查你的 Discord 私信设置。",
    );
  } catch (error) {
    throw new Error(
      `无法发送私信。请确认你允许此服务器成员私信：${error.message}`,
    );
  }
}

/**
 * Decide whether the bot should accept commands from one channel.
 *
 * Input:
 *   config {object}: Bridge configuration.
 *   channelId {string}: Discord channel id.
 * Output:
 *   {boolean}: True when the channel is allowed.
 */
function isAllowedMessage(config, message) {
  if (isDirectMessageChannel(message)) {
    return true;
  }

  if (config.allowedChannelIds.length === 0) {
    return true;
  }
  return config.allowedChannelIds.includes(message.channelId);
}

/**
 * Format one recent-job summary block for the status command.
 *
 * Input:
 *   jobs {object[]}: Recent job records.
 * Output:
 *   {string}: Human-readable status report.
 */
function formatStatus(jobs) {
  if (jobs.length === 0) {
    return "最近还没有任务。";
  }

  return jobs
    .map((job) =>
      [
        `- ${job.id} | ${job.status} | ${job.updatedAt}`,
        `  ${job.prompt.replace(/\s+/g, " ").slice(0, 100)}`,
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Mark one outbox job as failed without killing the whole bot process.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   jobId {string}: Job identifier.
 *   error {Error}: Delivery failure.
 * Output:
 *   {Promise<void>}
 */
async function markOutboxJobFailed(context, jobId, error) {
  try {
    await updateJob(context.config, jobId, {
      status: "failed",
      resultSummary: String(error.message || error).slice(0, 500),
    });
  } catch (updateError) {
    console.error(
      `Failed updating job ${jobId} after outbox error:`,
      updateError,
    );
  }
}

/**
 * Check whether one Discord id looks like a valid snowflake.
 *
 * Input:
 *   value {string}: Candidate Discord id.
 * Output:
 *   {boolean}: True when the value is an integer snowflake string.
 */
function isSnowflake(value) {
  return /^\d{16,20}$/u.test(String(value || ""));
}

/**
 * Build one stable conversation scope for context persistence.
 *
 * Input:
 *   message {import("discord.js").Message}: Discord message event.
 * Output:
 *   {string}: Thread id when available, otherwise channel id.
 */
function getConversationScopeId(message) {
  return String(
    message.channel?.isThread?.() ? message.channel.id : message.channelId,
  );
}

/**
 * Build all role-mention strings that belong to the bot in this guild.
 *
 * Input:
 *   message {import("discord.js").Message}: Discord message event.
 * Output:
 *   {string[]}: Role mention strings such as <@&123>.
 */
function getBotRoleMentions(message) {
  const roleIds = message.guild?.members?.me?.roles?.cache?.keys?.();
  if (!roleIds) {
    return [];
  }

  return [...roleIds].map((roleId) => `<@&${roleId}>`);
}

/**
 * Clamp one possibly invalid integer to a safe positive whole number.
 *
 * Input:
 *   value {number}: Candidate numeric value.
 *   fallback {number}: Fallback used when the value is invalid.
 * Output:
 *   {number}: Non-negative integer.
 */
function safePositiveInt(value, fallback) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return Math.max(0, Number(fallback || 0));
  }
  return Math.floor(normalized);
}

/**
 * Check whether one inbound message came from a Discord DM channel.
 *
 * Input:
 *   message {import("discord.js").Message}: Discord message event.
 * Output:
 *   {boolean}: True when the message is a DM.
 */
function isDirectMessageChannel(message) {
  return message.guildId === null;
}

/**
 * Push one high-level bridge status into the bot's Discord presence.
 *
 * Input:
 *   context {object}: Bridge services, client, and job counters.
 *   state {"ready"|"context"|"thinking"}: Desired bridge presence.
 * Output:
 *   {void}
 */
function syncPresence(context, state) {
  const user = context.client.user;
  if (!user) {
    return;
  }

  let activityName = "🟢 Ready for @codex";
  let presenceStatus = "online";

  if (state === "context") {
    activityName = `🧠 Loading context for ${context.activeJobs} task(s)`;
    presenceStatus = "idle";
  } else if (state === "thinking") {
    activityName = `🤔 Working on ${context.activeJobs} task(s)`;
    presenceStatus = "idle";
  }

  user.setPresence({
    status: presenceStatus,
    activities: [
      {
        name: activityName,
        type: ActivityType.Custom,
      },
    ],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
