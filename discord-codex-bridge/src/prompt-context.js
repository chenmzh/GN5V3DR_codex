/**
 * Build a dynamically sized prompt-memory package for the current job.
 *
 * Input:
 *   job {object}: Persisted job with prompt, short-term context, and memories.
 *   config {object}: Bridge runtime configuration with memory budget settings.
 * Output:
 *   {object}: Selected facts, episodes, recent turns, summary, and budget info.
 */
export function buildPromptContext(job, config) {
  const prompt = String(job.prompt || "").trim();
  const profile = classifyRequestProfile(prompt);
  const budget = estimateMemoryBudget(prompt, profile, config);

  let remainingChars = budget;

  const selectedFacts = takeItemsWithinBudget(
    normalizeFacts(job.memoryFacts),
    (fact) => formatFactLine(fact).length + 1,
    profile.factBudget,
    remainingChars,
  );
  remainingChars -= selectedFacts.usedChars;

  const selectedEpisodes = takeItemsWithinBudget(
    normalizeEpisodes(job.memoryEpisodes),
    (episode) => formatEpisodeBlock(episode).length + 1,
    profile.episodeBudget,
    remainingChars,
  );
  remainingChars -= selectedEpisodes.usedChars;

  const selectedTurns = takeRecentTurnsWithinBudget(
    normalizeTurns(job.conversationTurns),
    profile.turnBudget,
    remainingChars,
  );
  remainingChars -= selectedTurns.usedChars;

  const summary = selectSummaryText(
    String(job.conversationSummary || "").trim(),
    profile.summaryBudget,
    remainingChars,
    profile,
  );

  return {
    budget,
    profile: profile.name,
    memoryFacts: selectedFacts.items,
    memoryEpisodes: selectedEpisodes.items,
    recentTurns: selectedTurns.items,
    conversationSummary: summary,
  };
}

/**
 * Format one semantic fact into a prompt-friendly line.
 *
 * Input:
 *   fact {object}: Semantic memory fact.
 * Output:
 *   {string}: One formatted bullet line.
 */
export function formatFactLine(fact) {
  return `- [${fact.category || "fact"}] ${String(fact.text || "").trim()}`;
}

/**
 * Format one episodic memory block into prompt text.
 *
 * Input:
 *   episode {object}: Episodic memory entry.
 * Output:
 *   {string}: One formatted multi-line block.
 */
export function formatEpisodeBlock(episode) {
  return [
    `- ${String(episode.title || "episode").trim()}`,
    episode.resultSummary
      ? `  Result: ${String(episode.resultSummary).trim()}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Format one conversation turn into prompt text.
 *
 * Input:
 *   turn {object}: Stored recent conversation turn.
 * Output:
 *   {string}: One formatted turn line.
 */
export function formatTurnLine(turn) {
  return `[${turn.role}] ${turn.authorTag || "unknown"}: ${turn.content}`;
}

/**
 * Estimate the total character budget reserved for memory sections.
 *
 * Input:
 *   prompt {string}: Live user request.
 *   profile {object}: Request profile with complexity data.
 *   config {object}: Bridge runtime configuration.
 * Output:
 *   {number}: Character budget available for injected memory.
 */
function estimateMemoryBudget(prompt, profile, config) {
  const baseBudget = safePositiveInt(config.promptMemoryCharBudget, 2800);
  const promptPenalty = Math.min(
    Math.floor(String(prompt || "").length * 0.35),
    Math.floor(baseBudget * 0.45),
  );
  const profiledBudget = baseBudget + profile.budgetBonus - promptPenalty;
  const minBudget = safePositiveInt(config.promptMemoryMinCharBudget, 500);
  const maxBudget = safePositiveInt(config.promptMemoryMaxCharBudget, 4200);

  return clamp(profiledBudget, minBudget, maxBudget);
}

/**
 * Classify the live request so memory can expand for hard tasks and shrink
 * for small talk or status pings.
 *
 * Input:
 *   prompt {string}: Live user request.
 * Output:
 *   {object}: Budget profile for the request.
 */
function classifyRequestProfile(prompt) {
  const text = String(prompt || "").trim();
  const lower = text.toLowerCase();

  const isTiny = text.length > 0 && text.length <= 18;
  const isStatus = /^(status|help|你好|hi|hello|在吗|在不在|ping)$/iu.test(text);
  const isCodingTask = /(实现|修改|修复|重构|review|检查|debug|调试|代码|文件|仓库|repo|workspace|服务|bridge|discord|codex|matlab|脚本|test|测试|commit|push)/iu.test(text);
  const isFollowUp = /(继续|刚刚|上次|前面|那个|这些|这里|这个|再|same|that|those|continue|previous|earlier)/iu.test(lower);

  if (isStatus || isTiny) {
    return {
      name: "light",
      budgetBonus: -1100,
      factBudget: 180,
      episodeBudget: 0,
      turnBudget: 260,
      summaryBudget: 0,
      prefersSummary: false,
    };
  }

  if (isCodingTask || isFollowUp) {
    return {
      name: "deep",
      budgetBonus: 900,
      factBudget: 1000,
      episodeBudget: 650,
      turnBudget: 1200,
      summaryBudget: 900,
      prefersSummary: true,
    };
  }

  return {
    name: "normal",
    budgetBonus: 0,
    factBudget: 650,
    episodeBudget: 320,
    turnBudget: 700,
    summaryBudget: 450,
    prefersSummary: false,
  };
}

/**
 * Select ranked items while respecting both section and total budgets.
 *
 * Input:
 *   items {object[]}: Ranked memory items.
 *   sizeOf {Function}: Size estimator for one item.
 *   sectionBudget {number}: Max chars for this section.
 *   remainingChars {number}: Remaining total prompt budget.
 * Output:
 *   {object}: Selected items and consumed chars.
 */
function takeItemsWithinBudget(items, sizeOf, sectionBudget, remainingChars) {
  const budget = Math.max(0, Math.min(sectionBudget, remainingChars));
  const selectedItems = [];
  let usedChars = 0;

  for (const item of items) {
    const itemChars = Math.max(1, sizeOf(item));
    if (usedChars + itemChars > budget) {
      continue;
    }
    selectedItems.push(item);
    usedChars += itemChars;
  }

  return {
    items: selectedItems,
    usedChars,
  };
}

/**
 * Select the newest recent turns that fit into the current memory budget.
 *
 * Input:
 *   turns {object[]}: Ordered short-term conversation turns.
 *   sectionBudget {number}: Max chars for this section.
 *   remainingChars {number}: Remaining total prompt budget.
 * Output:
 *   {object}: Selected turn list and consumed chars.
 */
function takeRecentTurnsWithinBudget(turns, sectionBudget, remainingChars) {
  const budget = Math.max(0, Math.min(sectionBudget, remainingChars));
  const selectedTurns = [];
  let usedChars = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnChars = formatTurnLine(turn).length + 1;
    if (usedChars + turnChars > budget) {
      continue;
    }
    selectedTurns.unshift(turn);
    usedChars += turnChars;
  }

  return {
    items: selectedTurns,
    usedChars,
  };
}

/**
 * Decide how much of the rolling summary to inject for the current request.
 *
 * Input:
 *   summary {string}: Rolling long-term summary text.
 *   sectionBudget {number}: Max chars for this section.
 *   remainingChars {number}: Remaining total prompt budget.
 *   profile {object}: Request profile with summary preference flags.
 * Output:
 *   {string}: Summary slice or empty string.
 */
function selectSummaryText(summary, sectionBudget, remainingChars, profile) {
  if (!summary) {
    return "";
  }

  const budget = Math.max(0, Math.min(sectionBudget, remainingChars));
  if (budget < 120 || !profile.prefersSummary) {
    return "";
  }
  if (summary.length <= budget) {
    return summary;
  }
  if (budget <= 3) {
    return "";
  }

  return `...${summary.slice(-(budget - 3))}`;
}

/**
 * Normalize fact ranking so pinned and high-confidence facts go first.
 *
 * Input:
 *   facts {object[]}: Raw semantic facts from storage.
 * Output:
 *   {object[]}: Ranked fact array.
 */
function normalizeFacts(facts) {
  return [...(facts || [])].sort((left, right) => {
    return (
      Number(right.pinned || 0) - Number(left.pinned || 0) ||
      Number(right.confidence || 0) - Number(left.confidence || 0) ||
      Number(right.hitCount || 0) - Number(left.hitCount || 0)
    );
  });
}

/**
 * Normalize episodic memories so newer entries are considered first.
 *
 * Input:
 *   episodes {object[]}: Raw episodic memory list.
 * Output:
 *   {object[]}: Ranked episode array.
 */
function normalizeEpisodes(episodes) {
  return [...(episodes || [])].sort((left, right) =>
    String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
  );
}

/**
 * Normalize recent turns into a clean array for budgeting.
 *
 * Input:
 *   turns {object[]}: Raw recent conversation turns.
 * Output:
 *   {object[]}: Conversation turns.
 */
function normalizeTurns(turns) {
  return Array.isArray(turns) ? turns : [];
}

/**
 * Clamp one number into an inclusive range.
 *
 * Input:
 *   value {number}: Candidate value.
 *   minValue {number}: Minimum allowed value.
 *   maxValue {number}: Maximum allowed value.
 * Output:
 *   {number}: Clamped value.
 */
function clamp(value, minValue, maxValue) {
  return Math.min(Math.max(value, minValue), maxValue);
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
