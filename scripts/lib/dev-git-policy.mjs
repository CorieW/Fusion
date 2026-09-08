import fs from 'node:fs';
import path from 'node:path';
import { devNull } from 'node:os';

// FNXC:DevIsolation 2026-09-08-12:30: Preview Git is read-only metadata access, not a general subprocess escape. Parse shell callers into argv and neutralize executable Git configuration.
export function parseDevelopmentGitShell(command) {
  if (typeof command !== 'string' || !/^git(?:\.exe)?\s/i.test(command) || /[;&|<>`$()\r\n]/.test(command)) return undefined;
  const tokens = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g);
  if (!tokens || tokens.join(' ').replace(/\s+/g,' ') !== command.trim().replace(/\s+/g,' ')) return undefined;
  return tokens.slice(1).map(value => /^['"]/.test(value) ? value.slice(1,-1) : value);
}
export function developmentGitAllowed(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) return false;
  if (args.length === 1 && args[0] === '--version') return true;
  const [operation, ...rest] = args;
  const flags = {
    status: /^(?:--porcelain(?:=[12])?|--short|--branch|--untracked-files=(?:all|normal|no)|--ignored(?:=(?:traditional|matching|no))?|-z)$/,
    'rev-parse': /^(?:--git-dir|--git-common-dir|--show-toplevel|--show-prefix|--is-inside-work-tree|--is-bare-repository|--verify|--abbrev-ref|--symbolic-full-name|--short(?:=\d+)?|--show-object-format)$/,
    'ls-files': /^(?:--cached|--others|--exclude-standard|--stage|--deleted|--modified|-z)$/,
    branch: /^(?:--show-current|--list|--all|-a|--no-color)$/,
    log: /^(?:--oneline|--no-color|--no-decorate|--all|--first-parent|--max-count=\d+|-\d+|--format=(?:[^%]|%[HhsaenctidbrpP%x0-9])+|--pretty=(?:oneline|short|medium|full|fuller))$/,
    show: /^(?:--stat|--name-only|--name-status|--no-color|--no-patch|--format=)$/,
    diff: /^(?:--stat|--shortstat|--numstat|--name-only|--name-status|--no-color|--cached|--staged|--quiet|--exit-code|--no-renames|-z)$/,
  };
  if (!flags[operation]) return false;
  return rest.every(arg => flags[operation].test(arg) || (operation !== 'branch' && /^[\w./~^:@{}-]+$/.test(arg) && !arg.startsWith('-') && !arg.includes('..')));
}
export function isolatedGitInvocation(args, options, base) {
  const inside = value => path.resolve(value).toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep);
  const cwd = fs.realpathSync(options?.cwd ?? process.cwd());
  if (!inside(cwd)) throw new Error('Development Git directory must remain inside the sandbox');
  for (let dir=cwd; inside(dir); dir=path.dirname(dir)) {
    const metadata=path.join(dir,'.git');
    if (!fs.existsSync(metadata)) continue;
    if (!inside(fs.realpathSync(metadata)) || !fs.statSync(metadata).isDirectory()) throw new Error('Development Git cannot use redirected repositories');
    break;
  }
  const env=Object.fromEntries(Object.entries(options?.env ?? process.env).filter(([key])=>!/^GIT_|^SSH_AUTH_SOCK$/.test(key)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull,GIT_CONFIG_COUNT:'0',GIT_CEILING_DIRECTORIES:base,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
  const [operation,...rest]=args;
  const protections=['--no-pager','-c','core.fsmonitor=false','-c',`core.hooksPath=${path.join(base,'disabled-hooks')}`,'-c','protocol.allow=never','-c','credential.helper='];
  const diffProtection=['diff','show','log'].includes(operation)?['--no-ext-diff','--no-textconv']:[];
  return { args:[...protections,operation,...diffProtection,...rest],options:{...options,cwd,env,shell:false} };
}
