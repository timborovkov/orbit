import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateDatabase } from './migrate';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

export type StartWebOptions = {
  migrate?: () => Promise<void>;
  spawnServer?: (command: string, args: string[], options?: { cwd?: string }) => Promise<number>;
  serverPath?: string;
  argv?: string[];
  /** Injected in tests; defaults to copying static/public into a source-checkout standalone tree. */
  prepareStandalone?: (standaloneRoot: string, webRoot: string) => void;
};

function resolveServerPath(explicit?: string): string {
  if (explicit) return explicit;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../apps/web/server.js'),
    resolve(here, '../apps/web/.next/standalone/apps/web/server.js'),
  ];
  const match = candidates.find((path) => existsSync(path));
  if (!match) {
    throw new Error(`Standalone server missing. Looked for: ${candidates.join(', ')}`);
  }
  return match;
}

/** Copy Next standalone static assets for source-checkout starts. Docker images already ship them. */
export function prepareStandaloneAssets(standaloneRoot: string, webRoot: string): void {
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
}

function isSourceCheckoutStandalone(serverPath: string): boolean {
  return serverPath.replaceAll('\\', '/').includes('/.next/standalone/apps/web/server.js');
}

async function defaultSpawnServer(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: options.cwd });
    const onSignal = (signal: keyof typeof SIGNAL_EXIT_CODES) => {
      if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        resolvePromise(SIGNAL_EXIT_CODES[signal]);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

/** Apply migrations, then start the Next standalone server. Non-zero on failure. */
export async function startWeb(options: StartWebOptions = {}): Promise<number> {
  try {
    await (options.migrate ?? migrateDatabase)();
  } catch (error) {
    console.error('[orbit] migration failed; refusing to start web server', error);
    return 1;
  }

  let serverPath: string;
  try {
    serverPath = resolveServerPath(options.serverPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }

  const spawnServer = options.spawnServer ?? defaultSpawnServer;

  if (isSourceCheckoutStandalone(serverPath)) {
    // .../apps/web/.next/standalone/apps/web/server.js → standalone root + apps/web
    const standaloneAppDir = dirname(serverPath);
    const standaloneRoot = resolve(standaloneAppDir, '../..');
    const webRoot = resolve(standaloneRoot, '../..');
    (options.prepareStandalone ?? prepareStandaloneAssets)(standaloneRoot, webRoot);
    return await spawnServer(process.execPath, ['--bun', '--no-env-file', 'apps/web/server.js'], {
      cwd: standaloneRoot,
    });
  }

  return await spawnServer(process.execPath, ['--bun', '--no-env-file', serverPath]);
}

async function main(): Promise<void> {
  process.exitCode = await startWeb({ argv: process.argv.slice(2) });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('[orbit] web start failed', error);
    process.exit(1);
  });
}
