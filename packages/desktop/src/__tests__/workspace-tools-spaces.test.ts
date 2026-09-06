import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runWorkspaceBin } from "../../scripts/workspace-tools";

// FNXC:LocalDeployment 2026-09-06-20:59: Reproduce the real Windows build failure with a tool under a directory containing spaces and literal shell metacharacters in arguments.
it("runs a Node tool from a spaced workspace without interpreting arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "fusion workspace tool "));
  try {
    await mkdir(join(root, "node_modules/typescript/bin"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "node_modules/typescript/package.json"), '{"name":"typescript","bin":{"tsc":"bin/tsc"}}');
    await writeFile(join(root, "node_modules/typescript/bin/tsc"), "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))");
    const output = join(root, "result with spaces.json");
    const args = ["a b", "literal&value", "$HOME", "(quoted)"];
    await runWorkspaceBin("tsc", [output, ...args], root);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(args);
  } finally { await rm(root, { recursive: true, force: true }); }
});
