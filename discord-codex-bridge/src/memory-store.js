import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Read the most relevant long-term memories for one Discord request.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   options {object}: Lookup options with scopeId, authorId, and query text.
 * Output:
 *   {Promise<object>}: Ranked semantic facts and episodic memories.
 */
export async function readRelevantMemories(config, options) {
  const scopeId = String(options.scopeId || "");
  const authorId = String(options.authorId || "");
  const query = String(options.query || "");
  const tokens = extractSearchTokens(query);

  const [userFacts, scopeFacts, scopeEpisodes] = await Promise.all([
    readFacts(config, "user", authorId),
    readFacts(config, "scope", scopeId),
    readEpisodes(config, scopeId),
  ]);

  const factLimit = safePositiveInt(config.memoryFactRecallLimit, 6);
  const pinnedLimit = safePositiveInt(config.memoryPinnedFactLimit, 4);
  const episodeLimit = safePositiveInt(config.memoryEpisodeRecallLimit, 4);

  const pinnedFacts = userFacts
    .filter((fact) => fact.pinned)
    .sort(compareFactPriority)
    .slice(0, pinnedLimit);
  const pinnedKeys = new Set(pinnedFacts.map((fact) => fact.id));

  const relevantFacts = [...userFacts, ...scopeFacts]
    .filter((fact) => !pinnedKeys.has(fact.id))
    .map((fact) => ({ ...fact, _score: scoreTextEntry(fact.text, tokens, fact) }))
    .filter((fact) => fact._score > 0 || fact.pinned)
    .sort((left, right) => right._score - left._score || compareFactPriority(left, right))
    .slice(0, Math.max(0, factLimit - pinnedFacts.length))
    .map(stripInternalScore);

  const episodes = scopeEpisodes
    .map((episode) => ({
      ...episode,
      _score: scoreTextEntry(
        [episode.title, episode.prompt, episode.resultSummary].join(" "),
        tokens,
        episode,
      ),
    }))
    .filter((episode) => episode._score > 0)
    .sort((left, right) => right._score - left._score || compareRecent(right, left))
    .slice(0, episodeLimit)
    .map(stripInternalScore);

  return {
    facts: dedupeFacts([...pinnedFacts, ...relevantFacts]).slice(0, factLimit),
    episodes,
  };
}

/**
 * Extract and persist semantic memories from one user turn.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   payload {object}: User turn metadata such as scopeId, authorId, and text.
 * Output:
 *   {Promise<object[]>}: Facts that were inserted or refreshed.
 */
export async function updateMemoriesFromUserTurn(config, payload) {
  const scopeId = String(payload.scopeId || "");
  const authorId = String(payload.authorId || "");
  const authorTag = String(payload.authorTag || "unknown");
  const content = String(payload.content || "");
  const createdAt = String(payload.createdAt || new Date().toISOString());
  const sourceMessageId = String(payload.messageId || "");

  const extractedFacts = extractFactsFromUserText({
    scopeId,
    authorId,
    authorTag,
    content,
    createdAt,
    sourceMessageId,
  });

  if (extractedFacts.length === 0) {
    return [];
  }

  const userFacts = extractedFacts.filter((fact) => fact.target === "user");
  const scopeFacts = extractedFacts.filter((fact) => fact.target === "scope");

  await Promise.all([
    upsertFacts(config, "user", authorId, userFacts),
    upsertFacts(config, "scope", scopeId, scopeFacts),
  ]);

  return extractedFacts;
}

/**
 * Persist one episodic memory after a task finishes.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   payload {object}: Task metadata, prompt, and result summary.
 * Output:
 *   {Promise<object|null>}: Stored episode or null when not worth keeping.
 */
export async function rememberCompletedTask(config, payload) {
  const episode = buildCompletionEpisode(payload);
  if (!episode) {
    return null;
  }

  const scopeId = String(payload.scopeId || "");
  const episodes = await readEpisodes(config, scopeId);
  episodes.push(episode);

  const maxEpisodes = safePositiveInt(config.memoryMaxEpisodesPerScope, 80);
  const nextEpisodes = episodes
    .sort(compareRecent)
    .slice(0, maxEpisodes);

  await writeEpisodes(config, scopeId, nextEpisodes);
  return episode;
}

/**
 * Ensure the memory directories exist.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 * Output:
 *   {Promise<void>}
 */
export async function ensureMemoryStore(config) {
  await Promise.all([
    fs.mkdir(config.memoryDir, { recursive: true }),
    fs.mkdir(config.memoryUsersDir, { recursive: true }),
    fs.mkdir(config.memoryScopesDir, { recursive: true }),
  ]);
}

/**
 * Read one fact list from disk.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   target {"user"|"scope"}: Fact namespace.
 *   targetId {string}: User id or scope id.
 * Output:
 *   {Promise<object[]>}: Stored fact array.
 */
async function readFacts(config, target, targetId) {
  if (!targetId) {
    return [];
  }

  const filePath = factsPath(config, target, targetId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Persist one updated fact list to disk.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   target {"user"|"scope"}: Fact namespace.
 *   targetId {string}: User id or scope id.
 *   facts {object[]}: Serializable fact array.
 * Output:
 *   {Promise<void>}
 */
async function writeFacts(config, target, targetId, facts) {
  if (!targetId) {
    return;
  }
  await fs.writeFile(
    factsPath(config, target, targetId),
    JSON.stringify(facts, null, 2),
    "utf8",
  );
}

/**
 * Merge fresh facts into one stored fact list.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   target {"user"|"scope"}: Fact namespace.
 *   targetId {string}: User id or scope id.
 *   facts {object[]}: Newly extracted facts.
 * Output:
 *   {Promise<void>}
 */
async function upsertFacts(config, target, targetId, facts) {
  if (!targetId || facts.length === 0) {
    return;
  }

  const existingFacts = await readFacts(config, target, targetId);
  const factMap = new Map(existingFacts.map((fact) => [fact.key, fact]));

  for (const fact of facts) {
    const existing = factMap.get(fact.key);
    if (!existing) {
      factMap.set(fact.key, {
        ...fact,
        target,
        targetId,
        hitCount: 1,
        updatedAt: fact.createdAt,
      });
      continue;
    }

    factMap.set(fact.key, {
      ...existing,
      text: fact.text,
      confidence: Math.max(Number(existing.confidence || 0), Number(fact.confidence || 0)),
      pinned: Boolean(existing.pinned || fact.pinned),
      authorTag: fact.authorTag || existing.authorTag,
      sourceMessageId: fact.sourceMessageId || existing.sourceMessageId,
      updatedAt: fact.createdAt,
      hitCount: Number(existing.hitCount || 0) + 1,
    });
  }

  const maxFacts = safePositiveInt(config.memoryMaxFactsPerTarget, 120);
  const nextFacts = [...factMap.values()]
    .sort(compareFactPriority)
    .slice(0, maxFacts);

  await writeFacts(config, target, targetId, nextFacts);
}

/**
 * Read one episodic memory list for a scope.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   scopeId {string}: Stable Discord conversation scope id.
 * Output:
 *   {Promise<object[]>}: Stored episodic memories.
 */
async function readEpisodes(config, scopeId) {
  if (!scopeId) {
    return [];
  }

  const filePath = episodesPath(config, scopeId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Persist one episodic memory list for a scope.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   scopeId {string}: Stable Discord conversation scope id.
 *   episodes {object[]}: Serializable episodic memories.
 * Output:
 *   {Promise<void>}
 */
async function writeEpisodes(config, scopeId, episodes) {
  if (!scopeId) {
    return;
  }

  await fs.writeFile(
    episodesPath(config, scopeId),
    JSON.stringify(episodes, null, 2),
    "utf8",
  );
}

/**
 * Extract semantic facts from one explicit user instruction or preference.
 *
 * Input:
 *   payload {object}: User turn metadata and raw text.
 * Output:
 *   {object[]}: Targeted fact objects for user and/or scope memory.
 */
function extractFactsFromUserText(payload) {
  const sentences = splitIntoSentences(payload.content);
  const facts = [];

  for (const sentence of sentences) {
    const signals = classifySentence(sentence);
    if (!signals) {
      continue;
    }

    for (const target of signals.targets) {
      const text = sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence;
      facts.push({
        id: crypto.randomUUID().slice(0, 8),
        key: `${signals.category}:${target}:${canonicalizeText(sentence)}`,
        target,
        category: signals.category,
        text,
        confidence: signals.confidence,
        pinned: signals.pinned && target === "user",
        createdAt: payload.createdAt,
        authorTag: payload.authorTag,
        sourceMessageId: payload.sourceMessageId,
      });
    }
  }

  return facts;
}

/**
 * Classify one user sentence into a semantic memory candidate.
 *
 * Input:
 *   sentence {string}: One normalized sentence.
 * Output:
 *   {object|null}: Category, confidence, and target list.
 */
function classifySentence(sentence) {
  const text = sentence.trim();
  if (!text || text.length < 6) {
    return null;
  }

  const lower = text.toLowerCase();
  const mentionsScope = /(当前|这个|该|本)?(项目|仓库|repo|workspace|bridge|服务|子仓库|submodule|频道|thread|server)/iu.test(text);
  const isRule = /(以后|默认|必须|不要|不能|禁止|只用|只使用|需审批|审批|always|never|must|should|do not|don't|only)/iu.test(text);
  const isPreference = /(我喜欢|我偏好|prefer|请用|请使用|请回复|reply in|中文|英文|english|简洁|详细)/iu.test(lower);
  const isProjectFact = /(路径|目录|端口|仓库|repo|workspace|项目|服务|bridge|submodule|子仓库|discord|codex|matlab|tailscale)/iu.test(text);

  if (!isRule && !isPreference && !isProjectFact) {
    return null;
  }

  const category = isRule ? "rule" : isPreference ? "preference" : "project_fact";
  const confidence = isRule ? 0.98 : isPreference ? 0.92 : 0.75;
  const targets = new Set();

  if (isRule || isPreference) {
    targets.add("user");
  }
  if (mentionsScope || isProjectFact || /(这里|这个系统|这套|当前任务)/u.test(text)) {
    targets.add("scope");
  }

  if (targets.size === 0) {
    return null;
  }

  return {
    category,
    confidence,
    pinned: isRule || isPreference,
    targets: [...targets],
  };
}

/**
 * Build one episodic memory from a completed task.
 *
 * Input:
 *   payload {object}: Task metadata, prompt, and result summary.
 * Output:
 *   {object|null}: Episodic memory object or null when the task is trivial.
 */
function buildCompletionEpisode(payload) {
  const prompt = String(payload.prompt || "").trim();
  const resultSummary = String(payload.resultSummary || "").trim();
  const scopeId = String(payload.scopeId || "");

  if (!scopeId || !prompt || prompt.length < 8) {
    return null;
  }

  const importantTask = /(实现|修改|修复|review|检查|安装|重启|配置|添加|remove|refactor|memory|上下文|记忆|bridge|discord|codex)/iu.test(prompt);
  if (!importantTask) {
    return null;
  }

  return {
    id: crypto.randomUUID().slice(0, 8),
    type: "completed_task",
    title: prompt.length > 90 ? `${prompt.slice(0, 87)}...` : prompt,
    prompt,
    resultSummary: resultSummary.length > 220
      ? `${resultSummary.slice(0, 217)}...`
      : resultSummary,
    createdAt: String(payload.createdAt || new Date().toISOString()),
    authorTag: String(payload.authorTag || "unknown"),
  };
}

/**
 * Score one memory entry against the current query tokens.
 *
 * Input:
 *   text {string}: Memory text.
 *   tokens {string[]}: Search tokens from the live request.
 *   entry {object}: Memory entry with confidence and timestamps.
 * Output:
 *   {number}: Relevance score.
 */
function scoreTextEntry(text, tokens, entry) {
  let score = 0;
  const haystack = canonicalizeText(text);

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length >= 4 ? 4 : 2;
    }
  }

  score += Number(entry.confidence || 0) * 3;
  score += entry.pinned ? 3 : 0;
  score += recencyBonus(entry.updatedAt || entry.createdAt);
  return score;
}

/**
 * Extract searchable tokens from one user query.
 *
 * Input:
 *   text {string}: Raw query text.
 * Output:
 *   {string[]}: Deduplicated search token array.
 */
function extractSearchTokens(text) {
  const matches = String(text || "").match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_]{2,}/gu) || [];
  return [...new Set(matches.map((token) => token.toLowerCase()))];
}

/**
 * Split one raw message into sentence-like units.
 *
 * Input:
 *   text {string}: Raw message content.
 * Output:
 *   {string[]}: Normalized sentence array.
 */
function splitIntoSentences(text) {
  return String(text || "")
    .split(/[\r\n]+|[。！？!?；;]+/u)
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

/**
 * Normalize text into a canonical comparable string.
 *
 * Input:
 *   text {string}: Candidate text.
 * Output:
 *   {string}: Lowercased punctuation-light string.
 */
function canonicalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Sort facts so pinned, confident, and recent entries stay first.
 *
 * Input:
 *   left {object}: Left fact.
 *   right {object}: Right fact.
 * Output:
 *   {number}: Array sort comparator result.
 */
function compareFactPriority(left, right) {
  return (
    Number(right.pinned || 0) - Number(left.pinned || 0) ||
    Number(right.confidence || 0) - Number(left.confidence || 0) ||
    Number(right.hitCount || 0) - Number(left.hitCount || 0) ||
    compareRecent(right, left)
  );
}

/**
 * Sort memories by recency descending.
 *
 * Input:
 *   left {object}: Left memory entry.
 *   right {object}: Right memory entry.
 * Output:
 *   {number}: Array sort comparator result.
 */
function compareRecent(left, right) {
  return String(left.updatedAt || left.createdAt || "").localeCompare(
    String(right.updatedAt || right.createdAt || ""),
  );
}

/**
 * Remove internal transient scoring fields from one ranked entry.
 *
 * Input:
 *   entry {object}: Ranked entry with _score.
 * Output:
 *   {object}: Clean memory entry.
 */
function stripInternalScore(entry) {
  const { _score, ...cleanEntry } = entry;
  return cleanEntry;
}

/**
 * Remove duplicate facts that carry the same semantic text.
 *
 * Input:
 *   facts {object[]}: Ranked semantic facts.
 * Output:
 *   {object[]}: Deduplicated fact list in original order.
 */
function dedupeFacts(facts) {
  const seen = new Set();
  const uniqueFacts = [];

  for (const fact of facts) {
    const key = canonicalizeText(fact.text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueFacts.push(fact);
  }

  return uniqueFacts;
}

/**
 * Convert one timestamp into a tiny recency bonus.
 *
 * Input:
 *   isoString {string}: ISO timestamp.
 * Output:
 *   {number}: Small recency score boost.
 */
function recencyBonus(isoString) {
  if (!isoString) {
    return 0;
  }

  const ageMs = Date.now() - Date.parse(isoString);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }

  const oneDay = 24 * 60 * 60 * 1000;
  if (ageMs < oneDay) {
    return 1.5;
  }
  if (ageMs < 7 * oneDay) {
    return 0.75;
  }
  return 0;
}

/**
 * Build one absolute path for a fact file.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   target {"user"|"scope"}: Fact namespace.
 *   targetId {string}: User id or scope id.
 * Output:
 *   {string}: Absolute fact file path.
 */
function factsPath(config, target, targetId) {
  const baseDir =
    target === "user" ? config.memoryUsersDir : config.memoryScopesDir;
  return path.join(baseDir, `${encodeURIComponent(targetId)}.facts.json`);
}

/**
 * Build one absolute path for a scope episode file.
 *
 * Input:
 *   config {object}: Bridge configuration with memory directory paths.
 *   scopeId {string}: Stable Discord conversation scope id.
 * Output:
 *   {string}: Absolute episode file path.
 */
function episodesPath(config, scopeId) {
  return path.join(
    config.memoryScopesDir,
    `${encodeURIComponent(scopeId)}.episodes.json`,
  );
}

/**
 * Normalize a numeric configuration value into a safe positive integer.
 *
 * Input:
 *   value {unknown}: Candidate integer-like value.
 *   fallback {number}: Default value when parsing fails.
 * Output:
 *   {number}: Positive integer or zero.
 */
function safePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}
