import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// FNXC:LocalDeployment 2026-09-06-20:51: A managed Windows dashboard child handles its own graceful stop; Windows process.kill would forcibly terminate it.
const control = process.env.FUSION_LOCAL_CONTROL;
const token = process.env.FUSION_LOCAL_TOKEN;
const isDashboardChild = (process.env.FUSION_SUPERVISOR_PID === String(process.ppid) || process.env.FUSION_LOCAL_STANDALONE === '1')
  && process.argv.includes('dashboard');
if (control && token && isDashboardChild) {
  writeFileSync(path.join(control, 'child.json'), JSON.stringify({ token, pid: process.pid, parent: process.ppid, startedAt: new Date().toISOString() }));
  const timer = setInterval(() => {
    try {
      const stop = path.join(control, 'stop.json');
      if (existsSync(stop) && JSON.parse(readFileSync(stop, 'utf8')).token === token) {
        clearInterval(timer);
        process.emit('SIGTERM', 'SIGTERM');
      }
    } catch { /* Atomic marker publication may coincide with a polling tick. */ }
  }, 500);
  timer.unref();
}
