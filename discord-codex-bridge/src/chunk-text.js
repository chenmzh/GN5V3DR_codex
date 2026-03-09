/**
 * Split one long Discord reply into safe message chunks.
 *
 * Input:
 *   text {string}: Full message content.
 *   maxLength {number}: Maximum chunk length.
 * Output:
 *   {string[]}: Ordered message chunks.
 */
export function chunkText(text, maxLength = 1800) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return ["(empty response)"];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength / 2)) {
      cut = remaining.lastIndexOf(" ", maxLength);
    }
    if (cut < Math.floor(maxLength / 2)) {
      cut = maxLength;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
