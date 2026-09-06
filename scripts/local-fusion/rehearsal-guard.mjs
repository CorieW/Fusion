import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { URL } from 'node:url';

// FNXC:LocalDeployment 2026-09-06-20:56: Restored production data is inspected without provider calls, external notifications, or command execution.
const database = new URL(process.env.DATABASE_URL);
if (database.hostname !== '127.0.0.1' || database.port !== process.env.FUSION_REHEARSAL_PG_PORT) throw new Error('Rehearsal database target is not isolated');
process.env.FUSION_TEST_DATABASE_URL = database.href;
process.env.FUSION_TEST_DATABASE_MIGRATION_URL = database.href;
tls.connect = () => { throw new Error('Rehearsal blocks TLS connections'); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object' ? first?.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  const port = typeof first === 'object' ? first?.port : first;
  if ((host && !['localhost', '127.0.0.1', '::1'].includes(host)) || Number(port) !== Number(process.env.FUSION_REHEARSAL_PG_PORT)) throw new Error('Rehearsal permits only its isolated PostgreSQL connection');
  return connect.apply(this, args);
};
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name] = (...args) => {
  const error = new Error(`Rehearsal blocks subprocess execution: ${name} ${String(args[0]).split(/[\\/]/).at(-1)}`);
  if (name === 'spawnSync') {
    const empty = args[2]?.encoding ? '' : Buffer.alloc(0);
    return {pid:0,status:1,signal:null,error,stdout:empty,stderr:empty,output:[null,empty,empty]};
  }
  console.error(error.stack);
  throw error;
};
syncBuiltinESMExports();
