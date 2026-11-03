// Cross-platform "KEY=value command" runner used by npm scripts.
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const assignments = sep === -1 ? [] : args.slice(0, sep);
const command = sep === -1 ? args : args.slice(sep + 1);
const env = { ...process.env };
for (const a of assignments) {
  const i = a.indexOf('=');
  if (i > 0) env[a.slice(0, i)] = a.slice(i + 1);
}
const child = spawn(command.join(' '), { stdio: 'inherit', env, shell: true });
child.on('exit', (code) => process.exit(code ?? 1));
