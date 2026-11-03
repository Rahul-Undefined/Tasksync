// Safety net for `npm start`: if the host only ran `npm install` (no build step),
// build once before starting. Normal deployments run `npm run build` explicitly.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const needed = ['shared/dist/index.js', 'server/dist/index.js', 'web/dist/index.html'];
const missing = needed.filter((f) => !existsSync(f));
if (missing.length) {
  console.log(`[ensure-build] missing ${missing.join(', ')} — running npm run build`);
  execSync('npm run build', { stdio: 'inherit' });
}
