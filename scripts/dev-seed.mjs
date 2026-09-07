import path from 'node:path';
import { CentralCore, writeProjectIdentity } from '../packages/core/src/index.ts';

// Only the owned synthetic directory is registered; never copy production project identities.
const project = path.join(process.env.FUSION_DEV_ISOLATED_DIR, 'project');
if (process.cwd() !== project) throw new Error('Development bootstrap cwd mismatch.');
const central = new CentralCore();
await central.init();
try {
  const { project: registered } = await central.ensureProjectForPath({ path: project, name: 'Development Sandbox' });
  writeProjectIdentity(path.join(project, '.fusion'), { id: registered.id, createdAt: registered.createdAt });
} finally {
  await central.close();
}
