// GitHub cross-reference extraction — the closing-keyword ("Closes #123") and PR-mention parsers that decide
// whether a pull request has a linked issue at all.
//
// This is pure, side-effect-free regex logic that was stranded inside `src/db/repositories.ts` (#4882) — a ~386KB,
// D1-query-heavy repository-access file — even though the four host modules that consume it (`src/github/backfill.ts`,
// `src/review/enrichment-wire.ts`, `src/review/linked-issue-hard-rules.ts`, `src/signals/engine.ts`) want the parsing
// and nothing from the database layer. The engine could not reach into `src/` at all, so
// `signals/predicted-gate-engine.ts` carried a hand-written second copy that had silently diverged from the live
// gate's — it was missing the inline-code-span guard documented below, so the miner's predicted gate credited a
// linked issue for a body that the live gate reads as having none.
//
// Living in the engine, this is the single source of truth both gates resolve, so they can no longer disagree.

/** Hard cap on how many linked issues one body may declare, so a pathological body can't fan out unbounded work. */
export const MAX_LINKED_ISSUE_NUMBERS = 50;

export type LinkedIssueExtractionResult = {
  numbers: number[];
  /** True when the body declared MORE distinct issues than `limit` — the caller decides what an overflow means. */
  overflow: boolean;
};

export function extractLinkedIssueNumbersWithOverflow(
  text: string,
  repoFullName: string,
  limit = MAX_LINKED_ISSUE_NUMBERS,
): LinkedIssueExtractionResult {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  const target = repoFullName.toLowerCase();

  // GitHub's native closing-keyword linker does not treat backtick-wrapped text as a real
  // "Closes #N" directive, and this repo's own PR template contains "(e.g. `Closes #123`)".
  // Keep the original text while rejecting regex hits that occur inside inline code spans; replacing
  // spans with whitespace would let text on either side combine into a fake closing reference.
  const inlineCodeSpanRanges = [...text.matchAll(/`[^`\n]*`/g)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }));

  const linkedIssues: number[] = [];
  const seen = new Set<number>();
  // Matches both GitHub's bare `KEYWORD #N` and fully-qualified `KEYWORD owner/repo#N` closing syntax (#3862) --
  // the qualified form only counts when owner/repo case-insensitively matches THIS repo; a reference to a
  // different repo closes an issue there, not here, and must not spoof a same-repo linked-issue match.
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+)#|#)(\d+)\b/gi)) {
    const matchStart = match.index!;
    const matchEnd = matchStart + match[0].length;
    if (inlineCodeSpanRanges.some((range) => matchStart < range.end && matchEnd > range.start)) continue;
    const owner = match[1];
    if (owner && owner.toLowerCase() !== target) continue;
    const value = Number(match[2]);
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    if (linkedIssues.length >= normalizedLimit) return { numbers: linkedIssues, overflow: true };
    linkedIssues.push(value);
  }
  return { numbers: linkedIssues, overflow: false };
}

/** {@link extractLinkedIssueNumbersWithOverflow} for the callers that only need the numbers. */
export function extractLinkedIssueNumbers(text: string, repoFullName: string, limit = MAX_LINKED_ISSUE_NUMBERS): number[] {
  return extractLinkedIssueNumbersWithOverflow(text, repoFullName, limit).numbers;
}

/** Extract the PR numbers an issue body mentions in prose (`PR #12`, `pull request #12`). Deduped, positive only. */
export function extractLinkedPrNumbers(text: string): number[] {
  const matches = [...text.matchAll(/\b(?:PR|pull request)\s+#(\d+)\b/gi)];
  return [...new Set(matches.map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
}
