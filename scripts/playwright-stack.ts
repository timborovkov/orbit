/**
 * Starts the Bun worker alongside the production web server for Playwright.
 * Playwright waits on the web login URL; the worker drains queued simulations.
 */
export {};

const env = { ...process.env };

const worker = Bun.spawn(['bun', '--no-env-file', 'apps/worker/src/index.ts'], {
  env: {
    ...env,
    ORBIT_WORKER_ID: env.ORBIT_WORKER_ID ?? 'playwright-worker',
  },
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});

const webArgs = process.argv.slice(2);
const web = Bun.spawn(
  webArgs.length > 0 ? webArgs : ['bun', 'run', '--filter', '@orbit/web', 'start'],
  {
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

const shutdown = () => {
  worker.kill();
  web.kill();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const webCode = await web.exited;
worker.kill();
await worker.exited;
process.exit(webCode);
