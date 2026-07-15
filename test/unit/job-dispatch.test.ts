import { afterEach, describe, expect, it, vi } from "vitest";

import { processJob } from "../../src/queue/job-dispatch";
import { createTestEnv } from "../helpers/d1";
import type { JobMessage } from "../../src/types";

describe("processJob unknown job type (#5836)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a structured unknown_job_type_ignored warning and does not throw for an unrecognized type", async () => {
    const warnLogs: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnLogs.push(String(args[0]));
    });

    const env = createTestEnv();
    // A type outside the discriminated union — a stale/renamed job or a producer/consumer skew at runtime.
    const message = { type: "totally-unknown-job-type" } as unknown as JobMessage;

    await expect(processJob(env, message)).resolves.toBeUndefined();

    expect(warnLogs).toHaveLength(1);
    const log = JSON.parse(warnLogs[0] ?? "{}") as Record<string, unknown>;
    expect(log).toMatchObject({ level: "warn", event: "unknown_job_type_ignored", jobType: "totally-unknown-job-type" });
  });

  it("does not log the unknown-type warning for a recognized job type", async () => {
    const warnLogs: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnLogs.push(String(args[0]));
    });

    const env = createTestEnv();
    // A recognized type that no-ops safely without external I/O: retryFailedRelays fails open on an empty table.
    await processJob(env, { type: "retry-orb-relay" } as JobMessage);

    expect(warnLogs.some((line) => line.includes("unknown_job_type_ignored"))).toBe(false);
  });
});
