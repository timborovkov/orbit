import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outputDir = mkdtempSync(join(tmpdir(), 'react-doctor-'));

try {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.resolve('react-doctor')), '--json', '--output-dir', outputDir],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`Analyzer exited with status ${String(result.status)}.`);
  }

  const jsonStart = result.stdout.indexOf('{');
  const report = jsonStart === -1 ? null : JSON.parse(result.stdout.slice(jsonStart));
  const diagnosticsPath = join(outputDir, 'diagnostics.json');
  const diagnostics = report
    ? Array.isArray(report.diagnostics)
      ? report.diagnostics
      : []
    : existsSync(diagnosticsPath)
      ? JSON.parse(readFileSync(diagnosticsPath, 'utf8'))
      : null;
  if (!Array.isArray(diagnostics)) throw new Error('Analyzer did not emit diagnostics.');
  const total = Number(report?.summary?.totalDiagnosticCount ?? diagnostics.length);
  if ((report && !report.ok) || total > 0) {
    process.stdout.write(result.stdout);
    throw new Error(`Found ${String(total)} diagnostics.`);
  }

  const response = await fetch('https://www.react.doctor/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: gzipSync(Buffer.from(JSON.stringify({ diagnostics }))),
  });
  if (!response.ok) throw new Error(`Score API failed with HTTP ${String(response.status)}.`);
  const scored = await response.json();
  const score = Number(scored.score);
  if (!Number.isFinite(score)) throw new Error('Score API did not return a numeric score.');
  console.log(`React Doctor score: ${String(score)} (${String(scored.label ?? 'unlabeled')})`);
  if (score < 100) throw new Error(`Expected score 100, received ${String(score)}.`);
} catch (error) {
  console.error(`[react-doctor] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(outputDir, { force: true, recursive: true });
}
