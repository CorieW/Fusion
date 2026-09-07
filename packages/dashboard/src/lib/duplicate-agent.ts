import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { AgentStore, agentToConfigSnapshot, isEphemeralAgent, type Agent } from "@fusion/core";
import { badRequest } from "../api-error.js";

/** FNXC:Duplicate 2026-09-07-04:09: Copies have independent identity/files and start paused with heartbeats disabled. Run state, history, API keys and learned memory are not copied. */
export async function duplicateAgentConfiguration(source: Agent, sourceStore: AgentStore, targetStore: AgentStore, sourceRoot: string, targetRoot: string, name: string, preserveProvisioning = false): Promise<Agent> {
  if (isEphemeralAgent(source)) throw badRequest("Only permanent agents can be duplicated");
  const input = structuredClone(agentToConfigSnapshot(source));
  input.name = name;
  input.runtimeConfig = { ...input.runtimeConfig, enabled: false };
  delete input.memory;
  delete input.imageUrl;
  delete input.heartbeatProcedurePath;
  delete input.instructionsPath;
  delete input.bundleConfig;
  // FNXC:Duplicate 2026-09-07-04:09: Provisioning identities must not turn a copy back into the original built-in or retain prior run markers.
  for (const key of Object.keys(input.metadata ?? {})) {
    if (/task|session|run|pause|error|heartbeat/i.test(key) || (!preserveProvisioning && /builtin|provision/i.test(key))) delete input.metadata![key];
  }
  const instructions = source.instructionsPath ? await readFile(resolve(sourceRoot, source.instructionsPath), "utf8") : undefined;
  let heartbeat: string | undefined;
  if (source.heartbeatProcedurePath) {
    try { heartbeat = await readFile(resolve(sourceRoot, source.heartbeatProcedurePath), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const files = new Map<string, string>();
  if (source.bundleConfig) {
    const names = source.bundleConfig.mode === "external" ? source.bundleConfig.files : await sourceStore.listBundleFiles(source.id);
    for (const file of names) {
      if (basename(file) !== file || !file.endsWith(".md")) throw badRequest("Invalid instruction bundle filename");
      files.set(file, source.bundleConfig.mode === "external"
        ? await readFile(resolve(sourceRoot, source.bundleConfig.externalPath!, file), "utf8")
        : await sourceStore.readBundleFile(source.id, file));
    }
  }
  const created = await targetStore.createAgent(input);
  try {
    await targetStore.updateAgentState(created.id, "paused");
    if (source.imageUrl?.startsWith("/api/agents/")) {
      const entries = await readdir(resolve(sourceRoot, ".fusion/agents", source.id)).catch(() => [] as string[]);
      const avatar = entries.find(file => /^avatar\.(png|jpg|jpeg|gif|webp)$/.test(file));
      if (avatar) {
        const dir = resolve(targetRoot, ".fusion/agents", created.id);
        await mkdir(dir, { recursive: true });
        await writeFile(resolve(dir, avatar), await readFile(resolve(sourceRoot, ".fusion/agents", source.id, avatar)));
        await targetStore.updateAgent(created.id, { imageUrl: "/api/agents/" + created.id + "/avatar" });
      }
    } else if (source.imageUrl) await targetStore.updateAgent(created.id, { imageUrl: source.imageUrl });
    if (instructions !== undefined) {
      const relativePath = ".fusion/agents/" + created.id + "/INSTRUCTIONS.md";
      await mkdir(dirname(resolve(targetRoot, relativePath)), { recursive: true });
      await writeFile(resolve(targetRoot, relativePath), instructions);
      await targetStore.updateAgent(created.id, { instructionsPath: relativePath });
    }
    if (heartbeat !== undefined && created.heartbeatProcedurePath) {
      await mkdir(dirname(resolve(targetRoot, created.heartbeatProcedurePath)), { recursive: true });
      await writeFile(resolve(targetRoot, created.heartbeatProcedurePath), heartbeat);
    }
    for (const [file, content] of files) await targetStore.writeBundleFile(created.id, file, content);
    if (source.bundleConfig) await targetStore.setBundleConfig(created.id, { mode: "managed", entryFile: source.bundleConfig.entryFile, files: [...files.keys()] });
    return (await targetStore.getAgent(created.id))!;
  } catch (error) {
    // FNXC:Duplicate 2026-09-07-04:09: Only this request's new, paused identity is removed on failure; source files and agents are untouched.
    await targetStore.deleteAgent(created.id);
    throw error;
  }
}
