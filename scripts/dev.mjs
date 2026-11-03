// Runs the API (with local PGlite database + development sign-in) and the Vite dev server.
// Usage: npm run dev   → open http://localhost:5173
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  DEV_AUTH: process.env.DEV_AUTH ?? (process.env.ENTRA_CLIENT_ID ? 'false' : 'true'),
  PGLITE_DATA_DIR: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DATA_DIR ?? '.data/pglite'),
  BOOTSTRAP_ADMIN_EMAILS: process.env.BOOTSTRAP_ADMIN_EMAILS ?? 'dev.admin@myomnifi.com',
  PORT: process.env.PORT ?? '3000',
};
for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];

const run = (cmd) => spawn(cmd, { stdio: 'inherit', env, shell: true });
const build = run('npm run build -w shared');
build.on('exit', (code) => {
  if (code) process.exit(code);
  const children = [run('npm run dev -w server'), run('npm run dev -w web')];
  const stop = () => children.forEach((c) => c.kill());
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  children.forEach((c) => c.on('exit', (c2) => c2 && process.exit(c2)));
});
