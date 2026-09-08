import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** FNXC:ProjectDuplicate 2026-09-08-12:50: Offline registry paths still reserve their location but must not block unrelated copies. Resolve the nearest existing ancestor so junctions cannot hide overlap; permission errors remain fail-closed. */
export async function resolveRegisteredProjectPath(input: string, canonicalize = realpath): Promise<string> {
  const absolute = resolve(input);
  let cursor = absolute;
  const missing: string[] = [];
  for (;;) {
    try { return join(await canonicalize(cursor), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
