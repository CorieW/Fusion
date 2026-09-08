import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkflowReferences } from './backup.mjs';
test('saved references without a historical snapshot stop activation',async()=>{
  await assert.rejects(assertWorkflowReferences({},undefined,async()=>[{project_id:'p',task_id:'deleted-task',workflow_id:'builtin:coding'}]),/Missing historical workflow snapshots.*p\/builtin:coding/);
});
test('empty projects and fully snapshotted references permit activation',async()=>{
  await assertWorkflowReferences({},undefined,async()=>[]);
});
test('unavailable reference evidence fails closed',async()=>{
  await assert.rejects(assertWorkflowReferences({},undefined,async()=>{throw new Error('database unavailable');}),/database unavailable/);
});
