import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractLeadingStaticGateChecks,
  readStaticGateChecks,
  runStaticGateChecks,
} from "../run-static-gate-checks.mjs";

const check = (name) => `scripts/check-${name}.mjs`;
/*
FNXC:TestInfrastructure 2026-08-16-10:52:
FN-8991, FN-8994, and FN-9096 added runtime-skill-loader-drift,
workspace-package-graph, and cli-runtime-routing validators to the production
chains. Those chains are authoritative; retain their exact order here so this
mirror reports future declaration drift rather than preserving a stale list.
*/
const EXPECTED_GATE_CHECKS = [
  check(["no-", ["no", "hup"].join("")].join("")),
  check("no-cwd-relative-dashboard-test-reads"),
  check(["no-", "kill-", "40" + "40"].join("")),
  check("no-getdatabase"),
  check("prerebase-inert"),
  check("capacity-pool-id"),
  check("cli-runtime-routing"),
  check("no-node-only-core-imports-in-dashboard"),
  check("pi-versions-pinned"),
  check("workspace-package-graph"),
  check("no-test-timeout-appeasement"),
  check("no-comment-assertions-in-tests"),
  check("changeset-format"),
  check("mock-completeness"),
  check("inert-sync-lane-conversions"),
  check("runtime-skill-loader-drift"),
];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "static gate checks-"));
  mkdirSync(join(root, "scripts"));
  return root;
}

function writeFixtureCheck(root, name, source) {
  writeFileSync(join(root, "scripts", `${name}.mjs`), source);
}

const runFile = promisify(execFile);

test("CLI entry point runs validators and propagates failure from paths with spaces", async () => {
  const root = createFixture();
  try {
    const runner = join(root, "scripts", "run-static-gate-checks.mjs");
    copyFileSync(new URL("../run-static-gate-checks.mjs", import.meta.url), runner);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "test:gate:static": "node scripts/check-fixture.mjs" } }));
    writeFixtureCheck(root, "check-fixture", 'console.log("fixture inspected");');
    const result = await runFile(process.execPath, [runner], { cwd: root });
    assert.match(result.stdout, /fixture inspected/);
    assert.match(result.stdout, /1 validators passed/);
    writeFixtureCheck(root, "check-fixture", 'process.exit(1);');
    await assert.rejects(runFile(process.execPath, [runner], { cwd: root }), (error) => {
      assert.match(error.stderr, /1 static merge-gate validator failed/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity CLI inspects tracked source files with shell-independent Git arguments", async () => {
  const root = createFixture();
  try {
    mkdirSync(join(root, "packages", "example", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "example", "src", "clean.ts"), "export const value = 1;\n");
    await runFile("git", ["init", root]);
    await runFile("git", ["add", "packages"], { cwd: root });
    const result = await runFile(process.execPath, [fileURLToPath(new URL("../check-capacity-pool-id.mjs", import.meta.url))], { cwd: root });
    assert.match(result.stdout, /ok \(1 files inspected\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractLeadingStaticGateChecks keeps only the blocking validator prefix", () => {
  assert.deepEqual(
    extractLeadingStaticGateChecks("node scripts/check-one.mjs && node scripts/check-two.mjs && sh -c 'test lanes'"),
    ["scripts/check-one.mjs", "scripts/check-two.mjs"],
  );
  assert.throws(
    () => extractLeadingStaticGateChecks("pnpm --filter @fusion/engine test:core"),
    /must contain one or more canonical static validators/,
  );
});

test("production gate inventory contains each canonical validator exactly once", () => {
  const checks = readStaticGateChecks();
  assert.deepEqual(checks, EXPECTED_GATE_CHECKS);
  assert.equal(new Set(checks).size, checks.length);
});

test("runStaticGateChecks runs clean fixture validators and waits for all", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-first", 'console.log("first passed");');
    writeFixtureCheck(root, "check-second", 'console.log("second passed");');
    const messages = [];
    const results = await runStaticGateChecks(
      ["scripts/check-first.mjs", "scripts/check-second.mjs"],
      { root, log: (message) => messages.push(message) },
    );

    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.deepEqual(messages, ["[static-gate] 2 validators passed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStaticGateChecks reports every violating fixture validator before failing closed", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-clean", 'process.exit(0);');
    writeFixtureCheck(root, "check-first-violation", 'console.error("first violation"); process.exit(1);');
    writeFixtureCheck(root, "check-second-violation", 'console.error("second violation"); process.exit(2);');
    const errors = [];

    await assert.rejects(
      () => runStaticGateChecks(
        [
          "scripts/check-clean.mjs",
          "scripts/check-first-violation.mjs",
          "scripts/check-second-violation.mjs",
        ],
        { root, errorLog: (message) => errors.push(message) },
      ),
      /2 static merge-gate validators failed/,
    );

    assert.deepEqual(errors, [
      "[static-gate] validator failed: scripts/check-first-violation.mjs (exit 1)",
      "[static-gate] validator failed: scripts/check-second-violation.mjs (exit 2)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
