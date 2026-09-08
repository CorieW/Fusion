import { spawn } from "node:child_process";

function formatSpawnError(error: Error & { code?: unknown }): string {
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `spawn error: ${code}${error.message}`.trim();
}

export async function runGrokCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    /*
    FNXC:GrokCli 2026-07-08-00:00:
    Windows Grok installers/npm-style shims can expose `grok.cmd` or `grok.bat` on PATH, and Node cannot direct-spawn those batch wrappers without the command shell.
    Keep Unix/macOS on direct spawn so only the known Grok CLI probe/discovery seam uses shell resolution where Windows requires it. Copied verbatim from the Cursor plugin's cli-spawn seam (FN-7705).
    */
    // FNXC:ProviderProbe 2026-09-08-18:18: Launch-policy refusals can throw before a child exists. Preserve the same failed-command result as an asynchronous spawn error, with no timer or subprocess retained.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch (error) {
      finish({ code: 127, stdout, stderr: formatSpawnError(error instanceof Error ? error : new Error(String(error))) });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {
        // best effort
      }
      finish({ code: 124, stdout, stderr });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.once("error", (error: Error & { code?: unknown }) => {
      const diagnostic = formatSpawnError(error);
      stderr = stderr ? `${stderr}\n${diagnostic}` : diagnostic;
      finish({ code: 127, stdout, stderr });
    });
    child.once("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}
