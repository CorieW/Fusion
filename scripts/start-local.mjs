#!/usr/bin/env node
// FNXC:DevIsolation 2026-09-07-14:11: Never initialize or register the editable production project before entering isolation.
if (process.argv.length > 2) {
  console.error('pnpm local starts the isolated HMR preview. Use FUSION_API_PORT, FUSION_VITE_PORT and FUSION_DEV_ISOLATED_DIR to configure it; use pnpm dev for CLI arguments.');
  process.exitCode = process.argv.includes('--help') ? 0 : 1;
} else {
  await import('./dev-hmr.mjs');
}
