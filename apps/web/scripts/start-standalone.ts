import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = join(import.meta.dirname, '..');
const standaloneRoot = join(webRoot, '.next/standalone');
const server = join(standaloneRoot, 'apps/web/server.js');

if (!existsSync(server)) {
  console.error(
    'Standalone server missing. Run `bun run build` first, then start with the standalone output.',
  );
  process.exit(1);
}

const staticSrc = join(webRoot, '.next/static');
const staticDest = join(standaloneRoot, 'apps/web/.next/static');
const publicSrc = join(webRoot, 'public');
const publicDest = join(standaloneRoot, 'apps/web/public');

if (existsSync(staticSrc)) {
  mkdirSync(join(standaloneRoot, 'apps/web/.next'), { recursive: true });
  cpSync(staticSrc, staticDest, { recursive: true });
}
if (existsSync(publicSrc)) {
  cpSync(publicSrc, publicDest, { recursive: true });
}

const child = spawn(process.execPath, ['--bun', 'apps/web/server.js'], {
  cwd: standaloneRoot,
  env: {
    ...process.env,
    HOSTNAME: process.env.HOSTNAME ?? '0.0.0.0',
    PORT: process.env.PORT ?? '3000',
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
