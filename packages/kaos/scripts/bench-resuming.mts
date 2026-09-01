/**
 * Benchmarks the resuming-based stateful shell on the LOCAL host — the same
 * machine seam the tests use (`LocalResumingShellEnv`). Times four
 * scenarios end to end (spawn → wrapper preamble/body/epilogue → exit) and
 * reports the median wall time of N samples:
 *
 *   (a) stateless baseline — plain `spawn(bash, ['-c', 'true'])` through
 *       LocalResumingShellEnv, no wrapper at all;
 *   (b) stateful no-op fg — a `true` task on a warmed ResumingShell issued
 *       BACK TO BACK: the previous task's settle pre-spawns the next
 *       wrapper (the standby), but its preamble has barely started when the
 *       next task arrives, so most of it lands on the critical path — the
 *       burst-issue lower bound;
 *   (c) stateful mutating fg — `export BENCH_VAR=$RANDOM`: the same plus a
 *       real note (env diff) and a real durable commit (tmp+rename);
 *   (d) stateful no-op fg, SEQUENCED — K sequential `true` tasks on ONE
 *       shell with a think-time pause before each (longer than the measured
 *       preamble on this host), so the standby is fully warm at hand-off:
 *       the steady-state agent pattern, reported as the median of
 *       tasks 2..K (task 1 is the cold path).
 *
 * Run: pnpm --filter @moonshot-ai/kaos bench:resuming
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { detectEnvironmentFromNode } from '../src/environment';
import { LocalResumingShellEnv, ResumingShell } from '../src/stateful-shell/resuming';

/** Number of timed samples per scenario (a warm-up run precedes them). */
const N = 7;

/** Task count for the sequenced scenario (median over tasks 2..K). */
const K = 7;

/**
 * The pause before each sequenced task so its standby is fully warm —
 * longer than the measured wrapper preamble (spawn + bashrc + conda probe +
 * absorb ≈ 1.5 s) on the Windows Git Bash host this bench targets. It
 * simulates the agent's between-tool-calls latency: without it the
 * sequenced scenario degenerates into (b).
 */
const STANDBY_WARM_MS = 2_000;

async function timeMs(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

function medianMs(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

async function main(): Promise<void> {
  const env = await detectEnvironmentFromNode();
  const dir = await mkdtemp(join(tmpdir(), 'kimi-bench-resuming-'));
  const shellEnv = new LocalResumingShellEnv();
  // Every settled fg task pre-spawns an idle standby (a real bash blocked
  // on the frame read): dispose each shell or its standby would outlive
  // the bench and keep the process alive.
  const shells: ResumingShell[] = [];
  try {
    const rows: Array<{ label: string; samples: number[] }> = [];

    // (a) stateless baseline: plain spawn, no wrapper script at all.
    {
      const samples: number[] = [];
      for (let i = 0; i <= N; i++) {
        const ms = await timeMs(async () => {
          const proc = await shellEnv.spawn([env.shellPath, '-c', 'true'], {
            cwd: dir,
          });
          await proc.wait();
        });
        if (i > 0) samples.push(ms);
      }
      rows.push({ label: 'stateless bash -c true', samples });
    }

    // (b) stateful no-op fg: full wrapper, commit gate passes but the
    // snapshot is unchanged (note diff + dump + compare-skip), issued back
    // to back — the standby's preamble mostly lands on the critical path.
    {
      const shell = new ResumingShell(shellEnv, {
        snapshotDir: join(dir, 'snap-b'),
        initialCwd: dir,
        shellPath: env.shellPath,
      });
      shells.push(shell);
      const samples: number[] = [];
      for (let i = 0; i <= N; i++) {
        const ms = await timeMs(async () => {
          const task = await shell.runTask({
            id: `b${i}`,
            command: 'true',
            background: false,
          });
          await task.wait();
        });
        if (i > 0) samples.push(ms);
      }
      rows.push({ label: 'stateful fg no-op (true)', samples });
    }

    // (c) stateful mutating fg: a real env change every run → a real note
    // and a real durable commit (tmp+rename).
    {
      const shell = new ResumingShell(shellEnv, {
        snapshotDir: join(dir, 'snap-c'),
        initialCwd: dir,
        shellPath: env.shellPath,
      });
      shells.push(shell);
      const samples: number[] = [];
      for (let i = 0; i <= N; i++) {
        const ms = await timeMs(async () => {
          const task = await shell.runTask({
            id: `c${i}`,
            command: 'export BENCH_VAR=$RANDOM',
            background: false,
          });
          await task.wait();
        });
        if (i > 0) samples.push(ms);
      }
      rows.push({ label: 'stateful fg mutating (export)', samples });
    }

    // (d) stateful no-op fg, sequenced: K sequential tasks on ONE shell
    // with a think-time pause before each, so every task after the first is
    // handed to a fully warmed standby (critical path ≈ frame + phase 2 +
    // epilogue). Reported as the median of tasks 2..K.
    {
      const shell = new ResumingShell(shellEnv, {
        snapshotDir: join(dir, 'snap-d'),
        initialCwd: dir,
        shellPath: env.shellPath,
      });
      shells.push(shell);
      const samples: number[] = [];
      for (let i = 1; i <= K; i++) {
        // Let the standby spawned by the previous task's settle finish its
        // preamble (agent think-time), outside the timed section.
        await new Promise((resolve) => {
          setTimeout(resolve, STANDBY_WARM_MS);
        });
        const ms = await timeMs(async () => {
          const task = await shell.runTask({
            id: `d${i}`,
            command: 'true',
            background: false,
          });
          await task.wait();
        });
        if (i > 1) samples.push(ms);
      }
      rows.push({ label: 'stateful fg no-op sequenced (2..K)', samples });
    }

    console.log(`bench:resuming — ${env.shellName} at ${env.shellPath}, N=${N}, K=${K}`);
    console.log(
      'scenario                             median (s)   min (s)   max (s)   samples (s)',
    );
    for (const row of rows) {
      const s = row.samples;
      console.log(
        `${row.label.padEnd(36)} ${seconds(medianMs(s)).padStart(8)}   ${seconds(
          Math.min(...s),
        ).padStart(6)}   ${seconds(Math.max(...s)).padStart(6)}   ${s
          .map((x) => seconds(x))
          .join(' ')}`,
      );
    }
  } finally {
    await Promise.all(shells.map((shell) => shell.dispose().catch(() => {})));
    // dispose() signals the kills; give the standby wrappers a beat to
    // actually exit (their cwd is inside `dir`, which Windows locks while
    // a process sits in it), then retry the rmdir past the stragglers.
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

await main();
