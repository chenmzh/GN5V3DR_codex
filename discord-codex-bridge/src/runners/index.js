import { runCodexMode } from "./codex-runner.js";
import { runQueueMode } from "./queue-runner.js";
import { runOpenAiMode } from "./openai-runner.js";

/**
 * Execute one job with the configured runner mode.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   job {object}: Persisted job record.
 * Output:
 *   {Promise<object>}: Runner result with status and reply text.
 */
export async function runJob(context, job) {
  switch (context.config.runnerMode) {
    case "codex":
      return runCodexMode(context, job);
    case "queue":
      return runQueueMode(context, job);
    case "openai":
      return runOpenAiMode(context, job);
    default:
      throw new Error(`Unsupported RUNNER_MODE: ${context.config.runnerMode}`);
  }
}
