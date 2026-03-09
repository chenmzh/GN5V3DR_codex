/**
 * Queue-only runner that leaves execution to Codex or a human operator.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   job {object}: Persisted job record.
 * Output:
 *   {Promise<object>}: Result metadata to announce in Discord.
 */
export async function runQueueMode(context, job) {
  const inboxPath = `${context.config.inboxDir}/${job.id}.md`;
  return {
    status: "queued",
    reply: [
      `任务已入队: \`${job.id}\``,
      `工作区: \`${job.workspaceRoot}\``,
      `Inbox: \`${inboxPath.replace(/\\/g, "/")}\``,
      "处理完成后，把结果写到 `bridge-data/outbox/<jobId>.md`，机器人会自动回传。",
    ].join("\n"),
  };
}
