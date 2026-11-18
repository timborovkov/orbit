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

function portFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') return argv[i + 1];
    if (arg.startsWith('--port=')) return arg.slice('--port='.length);
  }
  return undefined;
}

const port = portFromArgv(process.argv.slice(2)) ?? process.env.PORT ?? '3000';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('PORT must be 1–65535');
  process.exit(1);
}

const child = spawn(process.execPath, ['--bun', 'apps/web/server.js'], {
  cwd: standaloneRoot,
  env: {
    ...process.env,
    HOSTNAME: process.env.HOSTNAME ?? '0.0.0.0',
    PORT: port,
  },
  stdio: 'inherit',
});

process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));

process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once('exit', (code, signal) => {
    if (signal) resolve(1);
    else resolve(code ?? 1);
  });
  child.once('error', reject);
});
