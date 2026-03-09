import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildPromptContext,
  formatEpisodeBlock,
  formatFactLine,
  formatTurnLine,
} from "../prompt-context.js";

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

  args.push(buildCodexPrompt(job, context.config));

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
 *   config {object}: Runner configuration with dynamic memory budgets.
 * Output:
 *   {string}: Full natural-language Codex prompt.
 */
function buildCodexPrompt(job, config) {
  const promptContext = buildPromptContext(job, config);
  const summary = String(promptContext.conversationSummary || "").trim();
  const history = promptContext.recentTurns.map(formatTurnLine).join("\n");
  const semanticMemory = promptContext.memoryFacts.map(formatFactLine).join("\n");
  const episodicMemory = promptContext.memoryEpisodes
    .map(formatEpisodeBlock)
    .join("\n");

  return [
    "You are Codex replying inside a Discord conversation.",
    `The active workspace is: ${job.workspaceRoot}`,
    "Continue the conversation naturally and helpfully.",
    "If the user asks for coding work, you may inspect or edit files in the workspace and report what you actually did.",
    "Do not claim to have done work you did not do.",
    "The older summary is a compressed memory of earlier turns. Treat it as background context, not as a verbatim transcript.",
    `Dynamic memory profile: ${promptContext.profile}.`,
    `Dynamic memory budget: about ${promptContext.budget} chars.`,
    semanticMemory
      ? "Semantic memory (stable user preferences, rules, and project facts):\n" +
        semanticMemory
      : "Semantic memory: (none)",
    episodicMemory
      ? "Episodic memory (relevant past tasks and outcomes):\n" + episodicMemory
      : "Episodic memory: (none)",
    summary
      ? "Older conversation summary:\n" + summary
      : "Older conversation summary: (none)",
    history ? "Recent conversation:\n" + history : "Recent conversation: (none)",
    `Latest user request:\n${job.prompt}`,
    "Reply in Chinese unless the user clearly asked for another language.",
  ].join("\n\n");
}
