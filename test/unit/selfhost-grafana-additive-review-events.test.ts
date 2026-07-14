import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AGENT_ACTION_CLASSES } from "../../src/settings/autonomy";

type Target = { queryText?: string; rawQueryText?: string; queryType?: string; timeColumns?: string[] };
type Panel = { id: number; type: string; title: string; description?: string; targets?: Target[] };

const dashboard = JSON.parse(readFileSync(join(process.cwd(), "grafana/dashboards/maintainer-reviews.json"), "utf8")) as {
  panels: Panel[];
};

const panel = (id: number): Panel => {
  const found = dashboard.panels.find((candidate) => candidate.id === id);
  expect(found, `panel ${id} is missing`).toBeDefined();
  return found!;
};

const sqlOf = (id: number): string => panel(id).targets?.[0]?.queryText ?? "";

// The additive panels added by #3717 part 2. Part 1 (#4134) only clarified the existing snapshot panels' wording.
const ADDITIVE_STAT_PANELS = [
  { id: 16, title: "Manual reviews entered", eventType: "agent.action.hold" },
  { id: 17, title: "Merges executed", eventType: "agent.action.merge" },
  { id: 18, title: "Closes executed", eventType: "agent.action.close" },
];

describe("maintainer-reviews dashboard: additive review-event panels (#3717)", () => {
  it("adds the additive panels without disturbing the existing snapshot panels", () => {
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // ids stay unique
    // The original review_targets-backed stat panels are untouched and still present.
    for (const id of [2, 3, 4, 5, 6, 7]) expect(sqlOf(id)).toContain("FROM review_targets");
  });

  it("counts from the append-only audit_events log, NOT the mutable review_targets snapshot", () => {
    // This is the whole point of the issue: review_targets.status/.verdict are current-state fields overwritten
    // as a PR's disposition changes, so a PR that passed through manual review and was then merged inside the
    // same window vanishes from the manual count. audit_events rows are never rewritten.
    for (const { id } of [...ADDITIVE_STAT_PANELS, { id: 19 }]) {
      const sql = sqlOf(id);
      expect(sql).toContain("FROM audit_events");
      expect(sql).not.toContain("review_targets");
      // Window on created_at (when the event happened), never updated_at (which is what makes the old panels a snapshot).
      expect(sql).toContain("unixepoch(created_at) >=");
      expect(sql).not.toContain("updated_at");
    }
  });

  it("keys each additive stat on the real event_type the agent actually emits", () => {
    for (const { id, title, eventType } of ADDITIVE_STAT_PANELS) {
      expect(panel(id).title).toBe(title);
      expect(sqlOf(id)).toContain(`event_type = '${eventType}'`);
      expect(sqlOf(id)).toContain("outcome = 'completed'");
    }
  });

  it("DRIFT GUARD: every event_type the panels query is one the code can actually emit", () => {
    // agent-execution.ts builds `agent.action.${actionClass}` from AGENT_ACTION_CLASSES, so a class renamed there
    // must not silently leave these panels reading zero forever. `hold` is emitted directly by processors.ts
    // (the manual-review disposition) rather than via an action class, so it is allowed alongside them.
    const queried = new Set<string>();
    for (const p of dashboard.panels.filter((candidate) => [16, 17, 18, 19].includes(candidate.id))) {
      for (const match of (p.targets?.[0]?.queryText ?? "").matchAll(/'(agent\.action\.[a-z_]+)'/g)) queried.add(match[1]!);
    }
    expect(queried.size).toBeGreaterThan(0);
    const emittable = new Set(["agent.action.hold", ...AGENT_ACTION_CLASSES.map((cls) => `agent.action.${cls}`)]);
    for (const eventType of queried) expect(emittable).toContain(eventType);
  });

  it("scopes to the selected repo via the audit_events target_key, since it has no repo column", () => {
    // audit_events.target_key is `${repoFullName}#${pullNumber}` (processors.ts), so the repo filter is a prefix
    // match rather than the `repo = ...` equality the review_targets panels use.
    for (const { id } of ADDITIVE_STAT_PANELS) {
      expect(sqlOf(id)).toContain("target_key LIKE ${repo:sqlstring} || '#%'");
      expect(sqlOf(id)).toContain("${repo:sqlstring} = '__ALL__'");
    }
  });

  it("renders the per-day breakdown as a real time series", () => {
    const timeseries = panel(19);
    expect(timeseries.type).toBe("timeseries");
    const target = timeseries.targets?.[0];
    expect(target?.queryType).toBe("time series");
    expect(target?.timeColumns).toEqual(["time"]);
    // Grafana's SQLite datasource wants epoch MILLIseconds for the time column.
    expect(target?.queryText).toContain("unixepoch(date(created_at)) * 1000 AS time");
    expect(target?.queryText).toContain("GROUP BY date(created_at), event_type");
  });

  it("explains in each panel description why the number differs from the snapshot above it", () => {
    for (const { id } of [...ADDITIVE_STAT_PANELS, { id: 19 }]) {
      const description = panel(id).description ?? "";
      expect(description).toMatch(/additive/i);
      expect(description).toContain("#3717");
    }
    // The manual-review panel is the one the maintainer actually reported as under-reporting, so it must say so.
    expect(panel(16).description).toContain("audit_events");
    expect(panel(16).description).toMatch(/snapshot/i);
  });

  it("keeps both queryText and rawQueryText in sync, as the datasource requires", () => {
    for (const id of [16, 17, 18, 19]) {
      const target = panel(id).targets?.[0];
      expect(target?.rawQueryText).toBe(target?.queryText);
    }
  });
});
