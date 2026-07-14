import { describe, expect, it } from "vitest";

import {
  extractLinkedIssueNumbers,
  extractLinkedIssueNumbersWithOverflow,
  extractLinkedPrNumbers,
  MAX_LINKED_ISSUE_NUMBERS,
} from "../../packages/loopover-engine/src/github/linked-references";
import { predictedGateEngineInternals } from "../../packages/loopover-engine/src/signals/predicted-gate-engine";
import { extractLinkedIssueNumbers as extractViaRepositoriesShim } from "../../src/db/repositories";

const REPO = "acme/widgets";

/** The repo's own `.github/pull_request_template.md` checklist line, verbatim. */
const PR_TEMPLATE_LINE =
  "- [ ] I linked a currently open issue this PR resolves (e.g. `Closes #123`) — a linked open issue is required for every contributor PR.";

describe("extractLinkedIssueNumbersWithOverflow() (#4882)", () => {
  it("extracts the bare `KEYWORD #N` closing form for every supported keyword", () => {
    for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      expect(extractLinkedIssueNumbers(`${keyword} #7`, REPO)).toEqual([7]);
    }
    expect(extractLinkedIssueNumbers("CLOSES #7", REPO)).toEqual([7]);
  });

  it("extracts the qualified `KEYWORD owner/repo#N` form only when owner/repo is THIS repo", () => {
    expect(extractLinkedIssueNumbers(`closes ${REPO}#9`, REPO)).toEqual([9]);
    expect(extractLinkedIssueNumbers("closes ACME/Widgets#9", REPO)).toEqual([9]);
    // A reference to a DIFFERENT repo closes an issue there, not here — it must not spoof a same-repo link.
    expect(extractLinkedIssueNumbers("closes other/repo#9", REPO)).toEqual([]);
  });

  it("REGRESSION: rejects a closing keyword wrapped in an inline code span, so the unedited PR template links nothing", () => {
    expect(extractLinkedIssueNumbers(PR_TEMPLATE_LINE, REPO)).toEqual([]);
    expect(extractLinkedIssueNumbers("`Closes #123`", REPO)).toEqual([]);
    expect(extractLinkedIssueNumbers(`\`closes ${REPO}#123\``, REPO)).toEqual([]);
  });

  it("still counts a real closing keyword that merely sits near an unrelated code span", () => {
    // Span AFTER the match, and span BEFORE the match — neither overlaps, so neither suppresses it.
    expect(extractLinkedIssueNumbers("closes #5 in `src/a.ts`", REPO)).toEqual([5]);
    expect(extractLinkedIssueNumbers("`src/a.ts` — closes #5", REPO)).toEqual([5]);
    // A span cannot be blanked out first: that would let the text on either side combine into a fake reference.
    expect(extractLinkedIssueNumbers("closes `nothing` #5", REPO)).toEqual([]);
  });

  it("dedupes repeats and drops non-positive / non-finite issue numbers", () => {
    expect(extractLinkedIssueNumbers("closes #4\nfixes #4\nresolves #6", REPO)).toEqual([4, 6]);
    expect(extractLinkedIssueNumbers("closes #0", REPO)).toEqual([]);
    // 400 digits overflows to Infinity, which is not an integer.
    expect(extractLinkedIssueNumbers(`closes #${"9".repeat(400)}`, REPO)).toEqual([]);
  });

  it("reports overflow once the body declares more distinct issues than the limit", () => {
    expect(extractLinkedIssueNumbersWithOverflow("closes #1 closes #2 closes #3", REPO, 2)).toEqual({
      numbers: [1, 2],
      overflow: true,
    });
    expect(extractLinkedIssueNumbersWithOverflow("closes #1 closes #2", REPO, 2)).toEqual({
      numbers: [1, 2],
      overflow: false,
    });
    expect(extractLinkedIssueNumbersWithOverflow("", REPO)).toEqual({ numbers: [], overflow: false });
  });

  it("normalizes a fractional or negative limit to a non-negative integer", () => {
    expect(extractLinkedIssueNumbersWithOverflow("closes #1 closes #2 closes #3", REPO, 2.9).numbers).toEqual([1, 2]);
    // A negative limit floors to 0: the very first hit already exceeds it.
    expect(extractLinkedIssueNumbersWithOverflow("closes #1", REPO, -5)).toEqual({ numbers: [], overflow: true });
  });

  it("defaults to MAX_LINKED_ISSUE_NUMBERS, and honours an explicit limit", () => {
    expect(MAX_LINKED_ISSUE_NUMBERS).toBe(50);
    const body = Array.from({ length: 51 }, (_, index) => `closes #${index + 1}`).join(" ");
    const result = extractLinkedIssueNumbersWithOverflow(body, REPO);
    expect(result.numbers).toHaveLength(MAX_LINKED_ISSUE_NUMBERS);
    expect(result.overflow).toBe(true);
    expect(extractLinkedIssueNumbers("closes #1 closes #2", REPO, 1)).toEqual([1]);
  });
});

describe("extractLinkedPrNumbers() (#4882)", () => {
  it("extracts, dedupes, and filters prose PR mentions", () => {
    expect(extractLinkedPrNumbers("see PR #12 and pull request #13, plus PR #12 again")).toEqual([12, 13]);
    expect(extractLinkedPrNumbers("PR #0")).toEqual([]);
    expect(extractLinkedPrNumbers(`PR #${"9".repeat(400)}`)).toEqual([]);
    expect(extractLinkedPrNumbers("no references here")).toEqual([]);
  });
});

describe("linked-reference parser convergence (#4882)", () => {
  it("the src/db/repositories shim resolves the engine implementation", () => {
    expect(extractViaRepositoriesShim(PR_TEMPLATE_LINE, REPO)).toEqual([]);
    expect(extractViaRepositoriesShim(`closes ${REPO}#42`, REPO)).toEqual([42]);
  });

  it("REGRESSION: the predicted gate now agrees with the live gate on an unedited PR template", () => {
    // Before the convergence, the engine's own copy had no inline-code-span guard, so it read the template's
    // "(e.g. `Closes #123`)" as a real link and predicted a PASS on a PR the live gate closes for having none.
    expect(predictedGateEngineInternals.extractLinkedIssueNumbers(PR_TEMPLATE_LINE, REPO)).toEqual([]);
    expect(predictedGateEngineInternals.extractLinkedIssueNumbers(PR_TEMPLATE_LINE, REPO)).toEqual(
      extractViaRepositoriesShim(PR_TEMPLATE_LINE, REPO),
    );
  });

  it("the two gates agree across the whole closing-keyword grammar", () => {
    const bodies = [
      "closes #1",
      `fixes ${REPO}#2`,
      "resolves other/repo#3",
      "`closes #4`",
      "closes #5 in `src/a.ts`",
      "closes #0",
      "nothing to see",
    ];
    for (const body of bodies) {
      expect(predictedGateEngineInternals.extractLinkedIssueNumbers(body, REPO)).toEqual(
        extractViaRepositoriesShim(body, REPO),
      );
    }
  });
});
