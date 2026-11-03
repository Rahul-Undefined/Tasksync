// Entry point for hosts configured with `node index.js`. Prefer `npm start`.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('server/dist/index.js') || !existsSync('web/dist/index.html')) {
  execSync('npm run build', { stdio: 'inherit' });
}
await import('./server/dist/index.js');
