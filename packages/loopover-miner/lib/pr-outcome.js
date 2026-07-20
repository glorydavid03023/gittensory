// Miner-local PR-outcome record (#4274). The miner's OWN local record of the outcomes of its OWN PRs — merged or
// closed — written to the miner's local SQLite via the generic append-only event-ledger.js, mirroring how
// manage-status.js layers a specific typed event (MANAGE_PR_UPDATE_EVENT + a payload normalizer + a thin writer)
// on top of that same ledger.
//
// DISTINCT from the server-side `pr_outcome` concept: src/review/outcomes-wire.ts's `recordPrOutcome` writes
// `pr_outcome` rows to the HOSTED backend's D1 audit tables from the GitHub App's webhook stream — that is the
// loopover SERVER recording ground truth for every contributor. THIS is a laptop-mode miner's local record of
// its own PRs (it may have no webhook relay at all): same concept name, different codebase layer, no shared code.
// The distinct `MINER_PR_OUTCOME_EVENT` local constant keeps the two from being conflated.
import { REJECTION_REASONS } from "./rejection-templates.js";
/** Event-ledger vocabulary for a miner-local PR outcome. */
export const MINER_PR_OUTCOME_EVENT = "pr_outcome";
/** The terminal decisions a miner records for one of its own PRs. */
export const MINER_PR_OUTCOME_DECISIONS = Object.freeze(["merged", "closed"]);
const decisionSet = new Set(MINER_PR_OUTCOME_DECISIONS);
const reasonSet = new Set(REJECTION_REASONS);
function optionalString(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
/**
 * Validate + normalize a PR-outcome payload; returns `null` on any malformed shape (mirrors manage-status.js's
 * `normalizeManageUpdatePayload`, so a bad row can neither be written nor read back). A `closed` decision may carry
 * a reason bucket drawn from {@link REJECTION_REASONS} (shared with the rejection-state-machine sibling); a `merged`
 * decision — or an unrecognized reason — normalizes the reason to `null` (a merged PR has no rejection reason).
 */
export function normalizePrOutcomePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const record = payload;
    if (!Number.isInteger(record.prNumber) || record.prNumber <= 0)
        return null;
    const decision = optionalString(record.decision);
    if (!decision || !decisionSet.has(decision))
        return null;
    const reasonRaw = optionalString(record.reason);
    const reason = decision === "closed" && reasonRaw !== null && reasonSet.has(reasonRaw) ? reasonRaw : null;
    return {
        prNumber: record.prNumber,
        decision: decision,
        closedAt: optionalString(record.closedAt),
        reason,
    };
}
/**
 * Thin writer over an INJECTED event ledger (same dependency-injection shape as manage-poll.js's
 * `recordManagePollSnapshot`, so it's unit-testable without a real ledger file). Appends one
 * {@link MINER_PR_OUTCOME_EVENT} scoped to the repo and returns the appended entry. Fail-soft on a malformed
 * snapshot: a missing repo or an invalid payload returns `null` rather than throwing (an unusable ledger is the
 * only hard error, since that is a programmer wiring mistake).
 */
export function recordPrOutcomeSnapshot(input, options = {}) {
    const eventLedger = options.eventLedger;
    if (!eventLedger || typeof eventLedger.appendEvent !== "function")
        throw new Error("invalid_event_ledger");
    const repoFullName = typeof input.repoFullName === "string" ? input.repoFullName.trim() : "";
    if (!repoFullName)
        return null;
    const payload = normalizePrOutcomePayload({
        prNumber: input.prNumber,
        decision: input.decision,
        closedAt: input.closedAt,
        reason: input.reason,
    });
    if (!payload)
        return null;
    return eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName, payload });
}
/**
 * Reconstruct the latest outcome per repo/PR from the ledger's ascending append-only event stream (mirrors
 * manage-status.js's `indexLatestManageUpdates`). Reads via the injected ledger's `readEvents(filter)` and reduces
 * the pure result — a later event for the same repo/PR supersedes an earlier one. Returns a `Map` keyed by
 * `repoFullName:prNumber`.
 */
export function readPrOutcomes(eventLedger, filter = {}) {
    const events = eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
    const latest = new Map();
    for (const event of Array.isArray(events) ? events : []) {
        if (!event || typeof event !== "object")
            continue;
        const row = event;
        if (row.type !== MINER_PR_OUTCOME_EVENT)
            continue;
        if (typeof row.repoFullName !== "string" || !row.repoFullName.trim())
            continue;
        const normalized = normalizePrOutcomePayload(row.payload);
        if (!normalized)
            continue;
        // Re-key on every event so Map iteration order tracks most-recently-UPDATED last, not first-seen (#7222). A
        // bare Map.set() on an existing key updates the value but leaves the key frozen at its original position, so a
        // later outcome for the same PR (e.g. closed-without-merge, then reopened + merged) stayed at its old slot --
        // breaking recency-ordered consumers like loop-reentry.js's countConsecutiveDisengagements. Deleting first
        // moves the freshly-updated entry to the end, matching this reducer's own "a later event supersedes" contract.
        const key = `${row.repoFullName}:${normalized.prNumber}`;
        latest.delete(key);
        latest.set(key, { ...normalized, repoFullName: row.repoFullName });
    }
    return latest;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItb3V0Y29tZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInByLW91dGNvbWUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsaUhBQWlIO0FBQ2pILDBHQUEwRztBQUMxRyxpSEFBaUg7QUFDakgsOEJBQThCO0FBQzlCLEVBQUU7QUFDRiw2R0FBNkc7QUFDN0csK0dBQStHO0FBQy9HLDhHQUE4RztBQUM5RyxrSEFBa0g7QUFDbEgsMkZBQTJGO0FBRTNGLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBRzdELDREQUE0RDtBQUM1RCxNQUFNLENBQUMsTUFBTSxzQkFBc0IsR0FBRyxZQUFxQixDQUFDO0FBRTVELHFFQUFxRTtBQUNyRSxNQUFNLENBQUMsTUFBTSwwQkFBMEIsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBVSxDQUFDLENBQUM7QUE4QnZGLE1BQU0sV0FBVyxHQUFHLElBQUksR0FBRyxDQUFTLDBCQUEwQixDQUFDLENBQUM7QUFDaEUsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLENBQVMsaUJBQWlCLENBQUMsQ0FBQztBQUVyRCxTQUFTLGNBQWMsQ0FBQyxLQUFjO0lBQ3BDLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3ZELElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixPQUFPLE9BQU8sSUFBSSxJQUFJLENBQUM7QUFDekIsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsTUFBTSxVQUFVLHlCQUF5QixDQUFDLE9BQWdCO0lBQ3hELElBQUksQ0FBQyxPQUFPLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDO1FB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