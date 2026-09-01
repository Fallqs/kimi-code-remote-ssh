import { RTS_VERSION } from '#/protocol/frames';
import { RtsServer } from '#/server/server';

// `--version` prints the bundle version and exits BEFORE any stdio
// handshake, so the deploy probe can check remote staleness with
// `node rts.js --version` over a one-shot ssh exec. `--rts-version` is the
// twin accepted for the fused SEA binary, where node's own `--version`
// handling may win over the embedded script's argv check.
if (process.argv.includes('--version') || process.argv.includes('--rts-version')) {
  process.stdout.write(`${RTS_VERSION}\n`);
  process.exit(0);
}

// The deployable RTS entrypoint: stdio is the framed RPC pipe, stderr is
// free for diagnostics (ssh carries it out-of-band to the local side).
const server = new RtsServer({
  input: process.stdin,
  output: process.stdout,
  log: message => {
    process.stderr.write(`[rts] ${message}\n`);
  },
});

// Best-effort child cleanup if init/sshd signals us directly; the stdin-EOF
// path in RtsServer already covers a dropped connection.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    server.shutdown('shutdown');
  });
}

process.on('unhandledRejection', error => {
  process.stderr.write(`[rts] unhandled rejection: ${String(error)}\n`);
  server.shutdown('error', error as Error);
});

// No top-level await: the SEA entry is the CommonJS build (dist/rts.cjs),
// which forbids it. ESM behavior is unchanged — the async tail floats with
// the unhandledRejection hook above as its failure path.
void (async () => {
  await server.start();
  const info = await server.waitClosed();
  if (info.reason === 'error') {
    process.stderr.write(`[rts] fatal: ${info.error ?? 'unknown error'}\n`);
  }
  process.exit(info.reason === 'error' ? 1 : 0);
})();
