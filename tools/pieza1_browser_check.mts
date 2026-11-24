import { spawnSync } from 'node:child_process';
import { computeInitialVisibleLogicalRange } from '../src/core/stockDetailChartNavigation.js';

// Reuses the local Playwright + installed Chrome setup from the Perf-3 harness.
const result = spawnSync('python', ['tools/pieza1_browser_check.py'], {
  input: JSON.stringify({ helper: computeInitialVisibleLogicalRange.toString() }), encoding: 'utf8',
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
