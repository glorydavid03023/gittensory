import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Resolve the engine from source (not its built dist), matching the convention in the other miner unit suites.
vi.mock("@loopover/engine", async () => import("../../packages/gittensory-engine/src/index"));

import {
  buildProviderMenu,
  companionPromptsFor,
  DEFAULT_TIMEOUT_MS,
  formatEnvValue,
  MASKED_SECRET,
  normalizeTimeoutMs,
  parseProviderChoice,
  createStdioWizardIo,
  renderEnvFile,
  runInitWizard,
  runInteractiveInit,
  summarizeCollectedEnv,
  WIZARD_ENV_FILENAME,
} from "../../packages/gittensory-miner/lib/init-wizard.js";

const NOW = "2026-07-13T00:00:00.000Z";
const TOKEN = "ghp_supersecrettoken";

/** A scripted, TTY-free IO: answers are dequeued in order; everything printed is captured for assertions. */
function fakeIo(answers: string[], masked: string[] = []) {
  const printed: string[] = [];
  return {
    printed,
    print: (line: string) => printed.push(line),
    prompt: async () => answers.shift() ?? "",
    promptMasked: async () => masked.shift() ?? "",
    close: () => {},
    output: () => printed.join("\n"),
  };
}

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "gt-wizard-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("init wizard pure helpers (#5176)", () => {
  it("builds the provider menu from the engine's canonical driver list", () => {
    expect(buildProviderMenu()).toEqual([
      "  1) noop",
      "  2) claude-cli",
      "  3) codex-cli",
      "  4) agent-sdk",
    ]);
  });

  it("parses a provider by menu number or by name, case/space-insensitively", () => {
    expect(parseProviderChoice("2")).toBe("claude-cli");
    expect(parseProviderChoice(" Claude-CLI ")).toBe("claude-cli");
    expect(parseProviderChoice("4")).toBe("agent-sdk");
  });

  it("rejects unknown, out-of-range, and empty provider answers (deny by default)", () => {
    for (const bad of ["", "   ", "0", "5", "99", "gpt-cli", undefined, 3 as unknown as string]) {
      expect(parseProviderChoice(bad as string)).toBeNull();
    }
  });

  it("derives companion prompts per provider from CODING_AGENT_DRIVER_CONFIG_ENV", () => {
    expect(companionPromptsFor("claude-cli").map((p) => p.envKey)).toEqual([
      "MINER_CODING_AGENT_CLAUDE_MODEL",
      "MINER_CODING_AGENT_TIMEOUT_MS",
    ]);
    expect(companionPromptsFor("codex-cli").map((p) => p.envKey)).toEqual([
      "MINER_CODING_AGENT_CODEX_MODEL",
      "MINER_CODING_AGENT_TIMEOUT_MS",
    ]);
    // noop / agent-sdk declare no model or timeout key, so they must prompt for nothing at all.
    expect(companionPromptsFor("noop")).toEqual([]);
    expect(companionPromptsFor("agent-sdk")).toEqual([]);
    // An unknown provider declares nothing either — the map lookup must not throw.
    expect(companionPromptsFor("not-a-driver" as never)).toEqual([]);
  });

  it("normalizes the timeout: blank keeps the default, non-positive-integers are rejected", () => {
    expect(normalizeTimeoutMs("")).toBe(DEFAULT_TIMEOUT_MS);
    expect(normalizeTimeoutMs("  ")).toBe(DEFAULT_TIMEOUT_MS);
    expect(normalizeTimeoutMs("1500")).toBe(1500);
    expect(normalizeTimeoutMs("", 900)).toBe(900);
    // A non-string answer is treated as "not supplied" and keeps the default.
    expect(normalizeTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(normalizeTimeoutMs(1500 as unknown as string)).toBe(DEFAULT_TIMEOUT_MS);
    for (const bad of ["0", "-5", "1.5", "abc", "10s"]) {
      expect(normalizeTimeoutMs(bad)).toBeNull();
    }
  });

  it("quotes env values only when ambiguous", () => {
    expect(formatEnvValue("ghp_abc123")).toBe("ghp_abc123");
    expect(formatEnvValue("claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(formatEnvValue("has space")).toBe('"has space"');
    expect(formatEnvValue("with#hash")).toBe('"with#hash"');
    expect(formatEnvValue("")).toBe('""');
  });

  it("renders a deterministic env file and omits empty values", () => {
    const text = renderEnvFile({ GITHUB_TOKEN: TOKEN, MINER_CODING_AGENT_PROVIDER: "noop", EMPTY: "" }, NOW);
    expect(text).toContain(`# Generated: ${NOW}`);
    expect(text).toContain(`GITHUB_TOKEN=${TOKEN}`);
    expect(text).toContain("MINER_CODING_AGENT_PROVIDER=noop");
    expect(text).not.toContain("EMPTY=");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("NEVER echoes the secret back in the summary", () => {
    const lines = summarizeCollectedEnv({ GITHUB_TOKEN: TOKEN, MINER_CODING_AGENT_PROVIDER: "noop" });
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines).toContain(`  GITHUB_TOKEN=${MASKED_SECRET}`);
    expect(lines).toContain("  MINER_CODING_AGENT_PROVIDER=noop");
  });
});

describe("runInitWizard flow (#5176)", () => {
  it("collects token + provider, writes a 0600 .env, and never prints the token", async () => {
    const io = fakeIo(["2", "claude-sonnet-4", "1500"], [TOKEN]);
    const result = await runInitWizard({ stateDir, io, env: {}, now: NOW });

    expect(result.cancelled).toBe(false);
    const envPath = join(stateDir, WIZARD_ENV_FILENAME);
    const written = readFileSync(envPath, "utf8");
    expect(written).toContain(`GITHUB_TOKEN=${TOKEN}`);
    expect(written).toContain("MINER_CODING_AGENT_PROVIDER=claude-cli");
    expect(written).toContain("MINER_CODING_AGENT_CLAUDE_MODEL=claude-sonnet-4");
    expect(written).toContain("MINER_CODING_AGENT_TIMEOUT_MS=1500");
    // The token must never reach the terminal — not while typing, not in the summary.
    expect(io.output()).not.toContain(TOKEN);
    expect(io.output()).toContain(MASKED_SECRET);
    // The file holds a credential, so it must be owner-only. Windows has no POSIX mode bits (chmod is a no-op
    // there), so this invariant is only assertable on POSIX — matching how the other miner store suites treat it.
    if (process.platform !== "win32") {
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    }
  });

  it("offers the default timeout when the answer is blank, and skips a blank model", async () => {
    const io = fakeIo(["2", "", ""], [TOKEN]);
    await runInitWizard({ stateDir, io, env: {}, now: NOW });
    const written = readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8");
    expect(written).toContain(`MINER_CODING_AGENT_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS}`);
    expect(written).not.toContain("MINER_CODING_AGENT_CLAUDE_MODEL");
  });

  it("leaves the timeout unset (driver default) when the answer is not a positive integer", async () => {
    const io = fakeIo(["2", "", "soon"], [TOKEN]);
    await runInitWizard({ stateDir, io, env: {}, now: NOW });
    const written = readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8");
    expect(written).not.toContain("MINER_CODING_AGENT_TIMEOUT_MS");
    expect(io.output()).toContain("not a positive whole number");
  });

  it("prompts for no companion vars when the provider declares none", async () => {
    const io = fakeIo(["1"], [TOKEN]); // noop
    await runInitWizard({ stateDir, io, env: {}, now: NOW });
    const written = readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8");
    expect(written).toContain("MINER_CODING_AGENT_PROVIDER=noop");
    expect(written).not.toContain("MINER_CODING_AGENT_TIMEOUT_MS");
  });

  it("cancels without writing when no token is supplied", async () => {
    const io = fakeIo(["2"], [""]);
    const result = await runInitWizard({ stateDir, io, env: {}, now: NOW });
    expect(result).toMatchObject({ cancelled: true, reason: "missing_token" });
    expect(() => readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8")).toThrow();
  });

  it("cancels without writing when the provider choice is invalid", async () => {
    const io = fakeIo(["nope"], [TOKEN]);
    const result = await runInitWizard({ stateDir, io, env: {}, now: NOW });
    expect(result).toMatchObject({ cancelled: true, reason: "invalid_provider" });
    expect(() => readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8")).toThrow();
  });

  it("refuses to clobber an existing .env unless the operator explicitly confirms", async () => {
    const envPath = join(stateDir, WIZARD_ENV_FILENAME);
    writeFileSync(envPath, "PRE_EXISTING=1\n");

    const declined = await runInitWizard({ stateDir, io: fakeIo(["n"]), env: {}, now: NOW });
    expect(declined).toMatchObject({ cancelled: true, reason: "declined_overwrite" });
    expect(readFileSync(envPath, "utf8")).toBe("PRE_EXISTING=1\n"); // untouched

    const accepted = await runInitWizard({ stateDir, io: fakeIo(["y", "1"], [TOKEN]), env: {}, now: NOW });
    expect(accepted.cancelled).toBe(false);
    expect(readFileSync(envPath, "utf8")).toContain("MINER_CODING_AGENT_PROVIDER=noop");
  });
});

describe("runInteractiveInit command (#5176)", () => {
  /** Point the miner state dir at the throwaway temp dir so `initLaptopState` and `doctor` stay fully local. */
  const envFor = () => ({ GITTENSORY_MINER_CONFIG_DIR: stateDir });

  it("initializes state, writes the .env, and re-runs doctor over the collected values", async () => {
    const io = fakeIo(["1"], [TOKEN]); // provider: noop (no companion prompts)
    const code = await runInteractiveInit([], envFor(), io);

    // doctor's exit code is passed through (a bare temp state dir legitimately fails some local checks).
    expect(typeof code).toBe("number");
    expect(io.output()).toContain("initialized");
    expect(io.output()).toContain("Re-running doctor with the new configuration:");
    expect(io.output()).not.toContain(TOKEN);

    const written = readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8");
    expect(written).toContain("MINER_CODING_AGENT_PROVIDER=noop");
    expect(written).toContain(`GITHUB_TOKEN=${TOKEN}`);
  });

  it("exits 0 when the operator declines to overwrite an existing .env (a choice, not a failure)", async () => {
    writeFileSync(join(stateDir, WIZARD_ENV_FILENAME), "PRE=1\n");
    const code = await runInteractiveInit([], envFor(), fakeIo(["n"]));
    expect(code).toBe(0);
    expect(readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8")).toBe("PRE=1\n");
  });

  it("exits 1 when a required answer is never supplied", async () => {
    expect(await runInteractiveInit([], envFor(), fakeIo(["1"], [""]))).toBe(1); // no token
    expect(await runInteractiveInit([], envFor(), fakeIo(["bogus"], [TOKEN]))).toBe(1); // bad provider
  });
});

describe("createStdioWizardIo (#5176)", () => {
  function stdio() {
    const input = new PassThrough();
    const output = new PassThrough();
    let seen = "";
    output.on("data", (chunk) => {
      seen += String(chunk);
    });
    return { input, output, seen: () => seen };
  }

  it("prints lines to the output stream", () => {
    const { input, output, seen } = stdio();
    const io = createStdioWizardIo(input, output);
    io.print("hello wizard");
    expect(seen()).toContain("hello wizard");
    io.close();
  });

  it("reads a plain answer from the input stream", async () => {
    const { input, output } = stdio();
    const io = createStdioWizardIo(input, output);
    const answered = io.prompt("Provider?");
    input.write("2\n");
    expect(await answered).toBe("2");
    io.close();
  });

  it("NEVER echoes a masked answer to the output stream", async () => {
    const { input, output, seen } = stdio();
    const io = createStdioWizardIo(input, output);
    const answered = io.promptMasked("Token");
    input.write(`${TOKEN}\n`);
    expect(await answered).toBe(TOKEN);
    // The prompt label is shown, but not a single character of the secret.
    expect(seen()).toContain("Token");
    expect(seen()).not.toContain(TOKEN);
    io.close();
  });

  it("erases the previous character on backspace/DEL (raw mode has no terminal line editor)", async () => {
    const { input, output } = stdio();
    const io = createStdioWizardIo(input, output);
    const answered = io.promptMasked("Token");
    input.write("ab\u0008\u007fc\n"); // "ab", erase twice, then "c" -> "c"
    expect(await answered).toBe("c");
    io.close();
  });

  it("rejects on Ctrl-C, since raw mode suppresses the terminal's own SIGINT", async () => {
    const { input, output } = stdio();
    const io = createStdioWizardIo(input, output);
    const answered = io.promptMasked("Token");
    input.write("\u0003");
    await expect(answered).rejects.toThrow(/input_cancelled/);
    io.close();
  });

  it("does not drop answers that arrive in the same chunk (piped multi-line input)", async () => {
    const { input, output } = stdio();
    const io = createStdioWizardIo(input, output);
    const first = io.prompt("One?");
    input.write("1\n2\n"); // both lines arrive together
    expect(await first).toBe("1");
    // The second line was buffered, not lost, so the next prompt resolves from it immediately.
    expect(await io.prompt("Two?")).toBe("2");
    io.close();
  });

  it("handles CRLF line endings", async () => {
    const { input, output } = stdio();
    const io = createStdioWizardIo(input, output);
    const answered = io.prompt("Q");
    input.write("windows\r\n");
    expect(await answered).toBe("windows");
    io.close();
  });

  it("waits for the newline when input arrives in partial chunks", async () => {
    const { input, output } = stdio();
    const io = createStdioWizardIo(input, output);
    const answered = io.prompt("Q");
    input.write("par"); // no newline yet — must not resolve
    input.write("tial\n");
    expect(await answered).toBe("partial");
    io.close();
  });

  it("on a TTY, enables raw mode for the secret (killing the terminal's own echo) and restores it after", async () => {
    const { input, output, seen } = stdio();
    const raw: boolean[] = [];
    // Present as a TTY that is NOT already raw, so the reader must switch it on and then put it back.
    Object.assign(input, {
      isTTY: true,
      isRaw: false,
      setRawMode(on: boolean) {
        raw.push(on);
        (this as unknown as { isRaw: boolean }).isRaw = on;
      },
    });

    const io = createStdioWizardIo(input, output);
    const answered = io.promptMasked("Token");
    input.write(`${TOKEN}\n`);

    expect(await answered).toBe(TOKEN);
    expect(raw).toEqual([true, false]); // raw on for the secret, restored to its prior state afterwards
    expect(seen()).not.toContain(TOKEN);
    io.close();
  });

  it("on a TTY, a plain (unmasked) prompt never touches raw mode", async () => {
    const { input, output } = stdio();
    const raw: boolean[] = [];
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode: (on: boolean) => raw.push(on) });

    const io = createStdioWizardIo(input, output);
    const answered = io.prompt("Provider?");
    input.write("1\n");

    expect(await answered).toBe("1");
    expect(raw).toEqual([]); // the terminal's normal echo is what the operator expects for a non-secret
    io.close();
  });
});
