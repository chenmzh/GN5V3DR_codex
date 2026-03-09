import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { loadConfig } from "./config.js";
import { chunkText } from "./chunk-text.js";
import {
  appendConversationTurn,
  readRecentConversation,
} from "./conversation-store.js";
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

const REACTION_THINKING = "🤔";
const REACTION_SUCCESS = "✅";
const REACTION_ERROR = "❌";

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

  const context = { client, config };

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bridge logged in as ${readyClient.user.tag}`);
    startOutboxPoller(context);
  });

  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    console.warn(`Discord shard ${shardId} disconnected: ${closeEvent.code}`);
  });

  client.on(Events.ShardResume, (replayedEvents, shardId) => {
    console.log(`Discord shard ${shardId} resumed after replaying ${replayedEvents} events.`);
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
  if (!isAllowedChannel(context.config, message.channelId)) {
    return;
  }

  const commandText = extractCommandText(context, message);
  if (commandText === null) {
    return;
  }

  const remainder = commandText.trim();
  if (!remainder || remainder === "help") {
    await replyInChunks(
      message,
      [
        `用法: ${context.config.commandPrefix} <任务描述>`,
        `状态: ${context.config.commandPrefix} status`,
        `帮助: ${context.config.commandPrefix} help`,
      ].join("\n"),
    );
    return;
  }

  if (remainder === "status") {
    const jobs = await listJobs(context.config, 5);
    const statusText = formatStatus(jobs);
    await replyInChunks(message, statusText);
    return;
  }

  await setMessageState(message, "thinking");
  const keepAlive = startThinkingHeartbeat(message);

  try {
    const conversationScopeId = getConversationScopeId(message);
    const recentConversation = await readRecentConversation(
      context.config,
      conversationScopeId,
      context.config.chatHistoryLimit,
    );

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
      conversationTurns: recentConversation,
    });

    await appendConversationTurn(context.config, conversationScopeId, {
      role: "user",
      authorTag: message.author.tag,
      content: remainder,
      createdAt: new Date().toISOString(),
      messageId: message.id,
    });

    await updateJob(context.config, job.id, { status: "running" });
    const result = await runJob(context, job);
    const finalJob = await updateJob(context.config, job.id, {
      status: result.status,
      resultSummary: result.reply.slice(0, 500),
    });

    await replyInChunks(message, result.reply);
    await appendConversationTurn(context.config, conversationScopeId, {
      role: "assistant",
      authorTag: context.client.user?.tag || "codex",
      content: result.reply,
      createdAt: new Date().toISOString(),
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
    throw new Error(`Invalid Discord channel id for job ${jobId}: ${job.source.channelId}`);
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
  const payload = `任务 ${jobId} 已完成。\n\n${reply}`;
  for (const chunk of chunkText(payload)) {
    await channel.send(chunk);
  }

  await updateJob(context.config, jobId, {
    status: "completed",
    resultSummary: reply.slice(0, 500),
  });
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
function extractCommandText(context, message) {
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
      return content
        .replace(mention, " ")
        .replace(/\s+/gu, " ")
        .trim();
    }
  }

  const botRoleMentions = getBotRoleMentions(message);
  for (const mention of botRoleMentions) {
    if (content.includes(mention)) {
      return content
        .replace(mention, " ")
        .replace(/\s+/gu, " ")
        .trim();
    }
  }

  return null;
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
 *   timer {NodeJS.Timeout|null}: Interval handle returned by startThinkingHeartbeat.
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
 * Reflect current processing state back onto the trigger message with reactions.
 *
 * Input:
 *   message {import("discord.js").Message}: Trigger message.
 *   state {"thinking"|"success"|"error"}: Desired message state.
 * Output:
 *   {Promise<void>}
 */
async function setMessageState(message, state) {
  try {
    switch (state) {
      case "thinking":
        await ensureReaction(message, REACTION_THINKING);
        await removeReaction(message, REACTION_SUCCESS);
        await removeReaction(message, REACTION_ERROR);
        break;
      case "success":
        await removeReaction(message, REACTION_THINKING);
        await ensureReaction(message, REACTION_SUCCESS);
        await removeReaction(message, REACTION_ERROR);
        break;
      case "error":
        await removeReaction(message, REACTION_THINKING);
        await ensureReaction(message, REACTION_ERROR);
        break;
      default:
        break;
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
 * Output:
 *   {Promise<void>}
 */
async function replyInChunks(message, text) {
  const chunks = chunkText(text);
  for (let index = 0; index < chunks.length; index += 1) {
    if (index === 0) {
      await message.reply(chunks[index]);
    } else {
      await message.channel.send(chunks[index]);
    }
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
function isAllowedChannel(config, channelId) {
  if (config.allowedChannelIds.length === 0) {
    return true;
  }
  return config.allowedChannelIds.includes(channelId);
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
    console.error(`Failed updating job ${jobId} after outbox error:`, updateError);
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
  return String(message.channel?.isThread?.() ? message.channel.id : message.channelId);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
