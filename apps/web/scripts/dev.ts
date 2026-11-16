import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { parseEnv } from '../src/lib/env';

if (process.argv.length > 2)
  throw new Error('Set PORT to choose a local port; dev server flags are not accepted');
const nodeEnv = process.env.NODE_ENV ?? 'development';
if (nodeEnv !== 'development') throw new Error('The dev launcher requires NODE_ENV=development');
const runtimeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: nodeEnv,
  ORBIT_LOCAL_DEV_SERVER: 'loopback',
};
// Validate opt-in bypass before launching. Normal login retains existing startup behaviour.
if (runtimeEnv.AUTH_DISABLED !== undefined && runtimeEnv.AUTH_DISABLED !== 'false')
  parseEnv(runtimeEnv);
const require = createRequire(import.meta.url);
const port = process.env.PORT ?? '3000';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error('PORT must be 1–65535');
const child = spawn(
  'node',
  [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', port],
  {
    cwd: new URL('../', import.meta.url).pathname,
    env: runtimeEnv,
    stdio: 'inherit',
  },
);
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once('exit', (code) => resolve(code ?? 1));
  child.once('error', reject);
});
