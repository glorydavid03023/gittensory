// Maintainer recap digest scheduling (#1963, #2248; flag GITTENSORY_MAINTAINER_RECAP). The cron-driven trigger
// for the CROSS-repo RecapReport digest (buildMaintainerRecap, #2239) -- distinct from generate-review-recap's
// single-repo ReviewRecap job, which is manually-triggerable only (review-recap.ts). Flag-gated and OFF by
// default, mirroring isOpsEnabled: flag-OFF, the cron enqueues no job and this module's exports are never
// invoked, so the deploy is byte-identical to today.
import { listRepositories } from "../db/repositories";
import { isAgentConfigured } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { buildRepoOutcomeCalibration } from "../services/outcome-calibration";
import { runMaintainerRecap, type MaintainerRecapRepoInput, type RunMaintainerRecapResult } from "../services/maintainer-recap";
import { loadGatePrecisionReport } from "../services/gate-precision";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveGittensorySelfRepoFullName } from "../config/gittensory-repo-focus-manifest";
import { errorMessage } from "../utils/json";

/** A manifest-sourced enable/cadence override (#2250) -- the `maintainerRecap` block of the gittensory
 *  self-repo's `.gittensory.yml` (see FocusManifestMaintainerRecapConfig). `present: false` (no block, or the
 *  repo has no manifest at all) means "no override configured", not "disabled" -- the caller falls through to
 *  the env vars in that case, exactly as if this parameter were omitted. */
export type MaintainerRecapManifestOverride = { present: boolean; enabled: boolean; cadence: RecapCadence };

/** True when the cross-repo maintainer recap digest is enabled. Config-as-code (#2250): a present
 *  `maintainerRecap` manifest block on the gittensory self-repo wins outright; otherwise falls back to the
 *  GITTENSORY_MAINTAINER_RECAP env flag (default OFF -- the cron enqueues no job and runMaintainerRecapJob is
 *  never invoked). Truthy env convention matches isOpsEnabled. */
export function isRecapEnabled(
  env: { GITTENSORY_MAINTAINER_RECAP?: string | undefined },
  manifestOverride?: MaintainerRecapManifestOverride | undefined,
): boolean {
  if (manifestOverride?.present) return manifestOverride.enabled;
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_MAINTAINER_RECAP ?? "");
}

export type RecapCadence = "daily" | "weekly";

const DEFAULT_RECAP_CADENCE: RecapCadence = "weekly";
/** 14:00 UTC -- distinct from the weekly-value-report's Monday-12:00 slot so the two digests never collide. */
const DEFAULT_RECAP_HOUR = 14;
/** Monday (UTC) -- same day the weekly-value-report's operator digest already uses. */
const DEFAULT_RECAP_DAY_OF_WEEK = 1;
const MIN_HOUR = 0;
const MAX_HOUR = 23;
const MIN_DAY_OF_WEEK = 0;
const MAX_DAY_OF_WEEK = 6;
const DEFAULT_RECAP_WINDOW_DAYS = 7;

function normalizeRecapCadence(value: string | undefined): RecapCadence {
  return value === "daily" || value === "weekly" ? value : DEFAULT_RECAP_CADENCE;
}

function normalizeRecapHour(value: string | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RECAP_HOUR;
  return Math.max(MIN_HOUR, Math.min(MAX_HOUR, Math.round(numeric)));
}

function normalizeRecapDayOfWeek(value: string | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RECAP_DAY_OF_WEEK;
  return Math.max(MIN_DAY_OF_WEEK, Math.min(MAX_DAY_OF_WEEK, Math.round(numeric)));
}

/**
 * True on the one cron tick per period the maintainer recap should fire: "daily" fires every day at the
 * configured hour; "weekly" fires ONLY on the configured day-of-week at that hour, so the tick fires at most
 * once per period. Caller passes the SAME `hour` / `dayOfWeek` enqueueScheduledJobs already derived from
 * `scheduledAt` (src/index.ts) -- no new Date parsing here. The hour/day-of-week knobs are env-only (not
 * manifest-overridable); ONLY the cadence itself (daily vs weekly) honors a present manifest override (#2250),
 * mirroring isRecapEnabled. An invalid GITTENSORY_RECAP_CADENCE value falls back to the "weekly" default
 * rather than silently firing daily, so a typo'd env var can't quietly spam the digest more often than
 * intended.
 */
export function shouldFireMaintainerRecap(
  env: {
    GITTENSORY_RECAP_CADENCE?: string | undefined;
    GITTENSORY_RECAP_HOUR?: string | undefined;
    GITTENSORY_RECAP_DAY?: string | undefined;
  },
  hour: number,
  dayOfWeek: number,
  manifestOverride?: MaintainerRecapManifestOverride | undefined,
): boolean {
  if (hour !== normalizeRecapHour(env.GITTENSORY_RECAP_HOUR)) return false;
  const cadence = manifestOverride?.present ? manifestOverride.cadence : normalizeRecapCadence(env.GITTENSORY_RECAP_CADENCE);
  return cadence === "daily" || dayOfWeek === normalizeRecapDayOfWeek(env.GITTENSORY_RECAP_DAY);
}

/** The repos this recap scans. Mirrors ops-wire.ts's opsScanRepos / pr-reconciliation.ts's watchedRepos: prefer
 *  agent-configured repos when any opted in (the acting-autonomy surface), else fall back to every registered
 *  repo so the digest still reports before the agent is enabled anywhere. */
async function recapScanRepos(env: Env): Promise<string[]> {
  const repos = (await listRepositories(env)).filter((repo) => repo.isRegistered);
  const configured: string[] = [];
  for (const repo of repos) {
    try {
      const settings = await resolveRepositorySettings(env, repo.fullName);
      if (isAgentConfigured(settings.autonomy)) configured.push(repo.fullName);
    } catch {
      /* a settings blip on one repo must not abort the whole scan */
    }
  }
  return configured.length > 0 ? configured : repos.map((repo) => repo.fullName);
}

/**
 * Config-as-code override lookup (#2250): read the `maintainerRecap` block off the gittensory self-repo's
 * `.gittensory.yml` (resolveGittensorySelfRepoFullName) -- the digest is an operator-level setting, not a
 * per-contributor-repo one, so ONE designated repo's manifest stands in for "the operator's own config" the
 * same way weekly-value-report/ops-alerts/selftune are operator-level, env-gated jobs. A manifest load failure
 * (network blip, malformed YAML) degrades to `{ present: false }` -- the caller then falls through to the env
 * vars, exactly as if no override existed, so a manifest hiccup can never accidentally disable or silently
 * reschedule the digest.
 */
export async function resolveMaintainerRecapManifestOverride(env: Env): Promise<MaintainerRecapManifestOverride> {
  try {
    const manifest = await loadRepoFocusManifest(env, resolveGittensorySelfRepoFullName(env));
    const config = manifest.maintainerRecap;
    return { present: config.present, enabled: config.enabled, cadence: config.cadence };
  } catch (error) {
    console.warn(JSON.stringify({ event: "maintainer_recap_manifest_override_error", message: errorMessage(error).slice(0, 200) }));
    return { present: false, enabled: false, cadence: DEFAULT_RECAP_CADENCE };
  }
}

/**
 * Load aggregator inputs for every scan repo, then delegate to {@link runMaintainerRecap} for build → format →
 * dual-channel delivery. A per-repo aggregator failure is logged and that repo is skipped — one repo's D1 hiccup
 * must not blank the whole digest (mirrors ops-wire.ts's runOpsAlerts).
 */
export async function runMaintainerRecapJob(env: Env, windowDays?: number): Promise<RunMaintainerRecapResult> {
  const resolvedWindowDays = windowDays ?? DEFAULT_RECAP_WINDOW_DAYS;
  const repoNames = await recapScanRepos(env);
  const repos: MaintainerRecapRepoInput[] = [];
  for (const repoFullName of repoNames) {
    try {
      const [gatePrecision, calibration] = await Promise.all([
        loadGatePrecisionReport(env, repoFullName, { windowDays: resolvedWindowDays }),
        buildRepoOutcomeCalibration(env, repoFullName, resolvedWindowDays),
      ]);
      repos.push({ gatePrecision, calibration });
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "maintainer_recap_repo_error", repo: repoFullName, message: errorMessage(error).slice(0, 200) }),
      );
    }
  }
  return runMaintainerRecap(env, { windowDays: resolvedWindowDays, repos });
}
