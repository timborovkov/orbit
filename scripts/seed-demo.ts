#!/usr/bin/env bun
/**
 * Demo workspace seed. Idempotent; use --reset to wipe only demo-owned rows first.
 *
 *   bun run db:seed:demo
 *   bun run db:seed:demo -- --reset
 *   bun run db:seed:demo -- --allow-non-local
 */
import { runDemoSeed } from '@/lib/seed';

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

const argv = process.argv.slice(2);
const unknown = argv.filter(
  (arg) => arg !== '--reset' && arg !== '--allow-non-local' && arg !== '--help',
);
if (hasFlag(argv, '--help')) {
  console.log(`Usage: bun run db:seed:demo [--reset] [--allow-non-local]

Seeds a realistic local Orbit workspace (John, Sarah, Maya) with versions,
budgets/usage, consent, approvals and run history.

  --reset             Delete only demo-owned rows (fixed IDs / orbit-demo-seed), then seed
  --allow-non-local   Permit a non-loopback DATABASE_URL (still refuses NODE_ENV=production)
`);
  process.exit(0);
}
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Try --help.`);
  process.exit(1);
}

try {
  const result = await runDemoSeed({
    reset: hasFlag(argv, '--reset'),
    allowNonLocal: hasFlag(argv, '--allow-non-local'),
  });
  console.log(
    `Demo seed complete (${result.reset ? 'reset + ' : ''}modules: ${result.modules.join(', ')}). ${result.agentCount} agents ready.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
