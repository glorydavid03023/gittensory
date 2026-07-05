// Units for the a11y regression analyzer (#2026). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectA11yRegression,
  scanA11yRegression,
  scanPatchForA11yRegression,
} from "../dist/analyzers/a11y-regression.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectA11yRegression: flags each rule on representative markup", () => {
  assert.equal(detectA11yRegression('<img src="/logo.png" />'), "img-alt");
  assert.equal(
    detectA11yRegression('<div onClick={() => open()}>Open</div>'),
    "click-events-have-key-events",
  );
  assert.equal(detectA11yRegression('<input type="email" />'), "label-control");
  assert.equal(detectA11yRegression('<div tabIndex={3}>Skip</div>'), "positive-tabindex");
});

test("detectA11yRegression: does not flag compliant markup", () => {
  assert.equal(detectA11yRegression('<img alt="Logo" src="/logo.png" />'), null);
  assert.equal(detectA11yRegression('<button onClick={() => open()}>Open</button>'), null);
  assert.equal(
    detectA11yRegression('<div role="button" onClick={() => open()}>Open</div>'),
    null,
  );
  assert.equal(
    detectA11yRegression('<div onClick={() => open()} onKeyDown={handleKey}>Open</div>'),
    null,
  );
  assert.equal(detectA11yRegression('<input aria-label="Email" type="email" />'), null);
  assert.equal(detectA11yRegression("<label><input type=\"email\" /></label>"), null);
  assert.equal(detectA11yRegression('<div tabIndex={0}>Focusable</div>'), null);
});

test("scanPatchForA11yRegression: flags added lines with correct locations", () => {
  const findings = scanPatchForA11yRegression(
    "src/Widget.tsx",
    patchOf([
      "export function Widget() {",
      '  return <img src="/logo.png" />;',
      "}",
    ]),
  );
  assert.deepEqual(findings, [
    { file: "src/Widget.tsx", line: 2, rule: "img-alt" },
  ]);
});

test("scanPatchForA11yRegression: skips test files and non-markup paths", () => {
  assert.deepEqual(
    scanPatchForA11yRegression("src/Widget.test.tsx", patchOf(['<img src="/x" />'])),
    [],
  );
  assert.deepEqual(
    scanPatchForA11yRegression("src/worker.ts", patchOf(['<img src="/x" />'])),
    [],
  );
});

test("scanPatchForA11yRegression: respects the findings cap", () => {
  const lines = Array.from({ length: 10 }, () => '<img src="/x" />');
  assert.equal(
    scanPatchForA11yRegression("src/a.tsx", patchOf(lines), { maxFindings: 2 }).length,
    2,
  );
});

test("scanA11yRegression: aggregates across files and renders a public-safe brief", async () => {
  const findings = await scanA11yRegression({
    repoFullName: "owner/repo",
    prNumber: 1,
    files: [
      { path: "src/a.tsx", patch: patchOf(['<div tabIndex={5}>Skip</div>']) },
      { path: "src/b.html", patch: patchOf(['<input type="text" />']) },
    ],
  });
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.rule, "positive-tabindex");
  assert.equal(findings[1]?.rule, "label-control");
  const { promptSection } = renderBrief({ a11y: findings });
  assert.match(promptSection, /Accessibility regressions/);
  assert.match(promptSection, /positive-tabindex/);
  assert.doesNotMatch(promptSection, /Skip/);
});
