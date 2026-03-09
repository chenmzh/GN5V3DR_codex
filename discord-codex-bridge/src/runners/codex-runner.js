import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run one Discord request through the local Codex CLI.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   job {object}: Persisted job record with recent conversation turns.
 * Output:
 *   {Promise<object>}: Completion status and assistant reply text.
 */
export async function runCodexMode(context, job) {
  const cliPath = context.config.codexCliPath;
  const outputPath = path.join(
    os.tmpdir(),
    `discord-codex-bridge-${job.id}-${Date.now()}.txt`,
  );

  const args = [
    "exec",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "--cd",
    job.workspaceRoot,
    "-o",
    outputPath,
  ];

  if (context.config.codexModel) {
    args.push("--model", context.config.codexModel);
  }

  args.push(buildCodexPrompt(job));

  try {
    await execFileAsync(cliPath, args, {
      cwd: context.config.rootDir,
      timeout: context.config.codexTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const reply = (await fs.readFile(outputPath, "utf8")).trim() || "(empty Codex response)";
    return {
      status: "completed",
      reply,
    };
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

/**
 * Build one Codex prompt from the recent Discord conversation context.
 *
 * Input:
 *   job {object}: Persisted job with prompt and conversation turns.
 * Output:
 *   {string}: Full natural-language Codex prompt.
 */
function buildCodexPrompt(job) {
  const summary = String(job.conversationSummary || "").trim();
  const history = (job.conversationTurns || [])
    .map(
      (turn) =>
        `[${turn.role}] ${turn.authorTag || "unknown"}: ${turn.content}`,
    )
    .join("\n");

  return [
    "You are Codex replying inside a Discord conversation.",
    `The active workspace is: ${job.workspaceRoot}`,
    "Continue the conversation naturally and helpfully.",
    "If the user asks for coding work, you may inspect or edit files in the workspace and report what you actually did.",
    "Do not claim to have done work you did not do.",
    "The older summary is a compressed memory of earlier turns. Treat it as background context, not as a verbatim transcript.",
    summary
      ? "Older conversation summary:\n" + summary
      : "Older conversation summary: (none)",
    history ? "Recent conversation:\n" + history : "Recent conversation: (none)",
    `Latest user request:\n${job.prompt}`,
    "Reply in Chinese unless the user clearly asked for another language.",
  ].join("\n\n");
}
