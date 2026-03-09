import OpenAI from "openai";

/**
 * OpenAI chat runner with recent Discord conversation context.
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
  const recentTurns = job.conversationTurns || [];
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
              "You are speaking in an ongoing Discord conversation.",
              "Answer clearly and concisely.",
              "Do not claim that you changed files unless you actually had a local execution layer.",
            ].join(" "),
          },
        ],
      },
      ...recentTurns.map(toOpenAiInput),
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

/**
 * Convert one stored Discord conversation turn into Responses API input.
 *
 * Input:
 *   turn {object}: Stored conversation turn with role and content.
 * Output:
 *   {object}: Responses API input item.
 */
function toOpenAiInput(turn) {
  const role = turn.role === "assistant" ? "assistant" : "user";
  const prefix = turn.authorTag ? `${turn.authorTag}: ` : "";
  return {
    role,
    content: [{ type: "input_text", text: `${prefix}${turn.content}`.trim() }],
  };
}
