import { loadConfig } from "./config.js";
import { ensureStore, writeOutboxReply } from "./job-store.js";

/**
 * CLI entrypoint for writing one reply file into bridge-data/outbox.
 *
 * Input:
 *   process.argv[2] {string}: Job id.
 *   process.argv[3..] {string[]}: Reply text parts.
 * Output:
 *   Writes one markdown file and logs its path to stdout.
 */
async function main() {
  const jobId = process.argv[2];
  const reply = process.argv.slice(3).join(" ").trim();

  if (!jobId || !reply) {
    throw new Error("Usage: npm run reply -- <jobId> <reply text>");
  }

  const config = loadConfig({ requireDiscordToken: false });
  await ensureStore(config);
  const filePath = await writeOutboxReply(config, jobId, reply);
  console.log(`Reply written to ${filePath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
