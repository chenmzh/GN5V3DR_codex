import OpenAI from "openai";

/**
 * OpenAI text runner for advisory answers when queue mode is not desired.
 *
 * Input:
 *   context {object}: Bridge services and configuration.
 *   job {object}: Persisted job record.
 * Output:
 *   {Promise<object>}: Completion status and text reply.
 */
export async function runOpenAiMode(context, job) {
  if (!context.config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for RUNNER_MODE=openai.");
  }
  if (!context.config.openAiModel) {
    throw new Error("OPENAI_MODEL is required for RUNNER_MODE=openai.");
  }

  const client = new OpenAI({ apiKey: context.config.openAiApiKey });
  const response = await client.responses.create({
    model: context.config.openAiModel,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You are a coding assistant connected to Discord.",
              `The active workspace is ${job.workspaceRoot}.`,
              "Answer clearly and concisely.",
              "Do not claim that you changed files unless you actually had a local execution layer.",
            ].join(" "),
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: job.prompt }],
      },
    ],
  });

  const reply = (response.output_text || "").trim() || "(empty OpenAI response)";
  return {
    status: "completed",
    reply,
  };
}
