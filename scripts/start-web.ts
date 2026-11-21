import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateDatabase } from './migrate';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

export type StartWebOptions = {
  migrate?: () => Promise<void>;
  spawnServer?: (command: string, args: string[]) => Promise<number>;
  serverPath?: string;
  argv?: string[];
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

async function defaultSpawnServer(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
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
