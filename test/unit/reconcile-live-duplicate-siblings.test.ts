import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileLiveDuplicateSiblings } from "../../src/queue/processors";
import { createInstallationToken } from "../../src/github/app";
import type { PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// reconcileLiveDuplicateSiblings re-fetches a duplicate sibling's LIVE state via createInstallationToken +
// the REST /pulls/{n} call, so mock the token mint (the test env holds no App key) and stub fetch per case.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
const mockedToken = vi.mocked(createInstallationToken);

function makePr(number: number, state: string, linkedIssues: number[]): PullRequestRecord {
  return { repoFullName: "owner/repo", number, title: `PR ${number}`, state, labels: [], linkedIssues };
}

/** Stub fetch so any /pulls/{n} returns the mapped live state; an unmapped path 404s (→ undefined live state). */
function stubLiveStates(states: Record<number, string>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [number, state] of Object.entries(states)) {
      if (url.includes(`/pulls/${number}`)) return new Response(JSON.stringify({ state }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("reconcileLiveDuplicateSiblings (#dup-winner / audit #15)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockRejectedValue(new Error("no app key in test env"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flag OFF ⇒ returns the cached list untouched and never hits GitHub", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "false";
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called when the flag is off");
    });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON but the PR links no issue ⇒ unchanged (no cluster to adjudicate)", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", []);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON, a higher overlapping sibling LIVE-closed ⇒ dropped because claim-time election lets higher numbers demote", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    stubLiveStates({ 12: "closed" });
    const siblings = [makePr(12, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([]);
  });

  it("flag ON, a higher overlapping sibling LIVE-open ⇒ kept (claim-time winner selection decides later)", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    stubLiveStates({ 12: "open" });
    const siblings = [makePr(12, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([12]);
  });

  it("flag ON, a sibling that does NOT overlap the issue set ⇒ unchanged (not a cluster member)", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    const siblings = [makePr(12, "open", [2])];
    const pr = makePr(9, "open", [1]);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON, a sibling already cached non-open ⇒ unchanged (the cache already excludes it)", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    const siblings = [makePr(5, "closed", [1])];
    const pr = makePr(9, "open", [1]);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON, a lower overlapping sibling LIVE-closed ⇒ dropped so the remaining open cluster is adjudicated from live members", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    stubLiveStates({ 5: "closed" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([]);
  });

  it("flag ON, a lower overlapping sibling LIVE-open ⇒ kept (this PR is genuinely a loser)", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    stubLiveStates({ 5: "open" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([5]);
  });

  it("flag ON, an unreadable live fetch ⇒ fails OPEN (sibling kept; no new spare on a transient hiccup)", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    stubLiveStates({}); // every /pulls/{n} 404s ⇒ undefined live state
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([5]);
  });

  it("flag ON, two overlapping siblings (one live-closed, one live-open) ⇒ only the closed one is dropped", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    stubLiveStates({ 4: "closed", 12: "open" });
    const siblings = [makePr(4, "open", [1]), makePr(12, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([12]);
  });

  it("flag ON, a numeric installation whose token mint THROWS ⇒ falls back to the public token and still reconciles", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    env.GITHUB_PUBLIC_TOKEN = "public-tok";
    stubLiveStates({ 5: "closed" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, 4242, "owner/repo", pr, siblings);
    expect(mockedToken).toHaveBeenCalledWith(env, 4242);
    expect(result.map((p) => p.number)).toEqual([]);
  });

  it("flag ON, a numeric installation whose token mint SUCCEEDS ⇒ uses the installation token to reconcile", async () => {
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";
    mockedToken.mockResolvedValue("inst-tok");
    stubLiveStates({ 5: "closed" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, 4242, "owner/repo", pr, siblings);
    expect(mockedToken).toHaveBeenCalledWith(env, 4242);
    expect(result.map((p) => p.number)).toEqual([]);
  });

  it("REGRESSION: bounds the live per-sibling fan-out instead of bursting one fetch per sibling at once (#5835)", async () => {
    // A popular linked issue can hold dozens of duplicate PRs. The old `Promise.all(overlapping.map(...))` fired
    // one live REST call per sibling SIMULTANEOUSLY out of a single webhook delivery, against the ~5000/hr bucket
    // every managed repo shares through one installation. The fan-out is now capped at 10, matching the two
    // sibling caps in processors.ts (CONTRIBUTOR_CAP_/GLOBAL_OPEN_ITEM_LIVE_CHECK_CONCURRENCY).
    const env = createTestEnv();
    env.LOOPOVER_DUPLICATE_WINNER = "true";

    let inFlight = 0;
    let peakInFlight = 0;
    let totalFetches = 0;
    vi.stubGlobal("fetch", async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      totalFetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return new Response(JSON.stringify({ state: "open" }), { status: 200 });
    });

    const siblings = Array.from({ length: 40 }, (_, index) => makePr(index + 1, "open", [1]));
    const pr = makePr(999, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);

    expect(totalFetches).toBe(40); // every sibling is still verified -- the cap bounds concurrency, not coverage
    expect(peakInFlight).toBeLessThanOrEqual(10);
    expect(peakInFlight).toBe(10); // and it really does saturate the cap, rather than serialising
    // All 40 came back live-open, so none is dropped: same result the unbounded version produced.
    expect(result).toBe(siblings);
  });
});
