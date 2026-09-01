/**
 * Dev-time detection of bash's bookkeeping (shell-internal) variables — the
 * data behind `shellStateFilter.generated.ts`.
 *
 * The stateful-shell protocol dumps/restores user state via `declare -p`;
 * bash's own bookkeeping variables must be excluded from that dump (readonly
 * ones break the restore, volatile ones break dump determinism, lazy
 * function-context ones pollute it). Which variables those are is a property
 * of the bash build, so instead of a hand-maintained list this module probes
 * an isolated bash:
 *
 *  - readonly: `declare -p` flag inspection (`-r`) — attribute, not a list;
 *  - volatile: two bulk `declare -p | sort` captures with `sleep 1` between
 *    them (second-granularity vars like SECONDS need the sleep), plus
 *    force-referenced PRNGs and a `=~` match;
 *  - lazy / function-context: a capture inside a probe function (and a deeper
 *    subshell, which also unmasks BASH_SUBSHELL) after exercising the lazy
 *    paths (`=~`, bare `read`, `pushd`) — names that appear only there.
 *
 * Detection runs against a SANITIZED environment: the sets are bash-intrinsic
 * and a minimal env keeps user secrets out of the probe's dump files and
 * makes the result reproducible.
 *
 * Every detection ends with a self-check: two simulated commit/absorb cycles
 * filtered by the derived regex must produce byte-identical dumps. A missed
 * volatile/context variable (e.g. a BASH_SUBSHELL-style ratchet, where the
 * absorbed value increments on the next fork) breaks that equality, so the
 * generator refuses to emit a bad artifact instead of shipping one.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

export interface ShellStateFilterDetection {
  readonly bashVersion: string;
  readonly readonlyNames: readonly string[];
  readonly volatileNames: readonly string[];
  readonly lazyNames: readonly string[];
  /** Sorted union of every detected bookkeeping name. */
  readonly all: readonly string[];
  /** The alternation body of the exclusion regex (no anchors). */
  readonly alternation: string;
}

const BASH_TIMEOUT_MS = 30_000;

/** Minimal env for the probe bash: bookkeeping sets are env-independent. */
function sanitizedEnv(): Record<string, string> {
  const allow = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    // Windows / Git Bash essentials
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'PATHEXT',
    'MSYSTEM',
    'COMSPEC',
  ];
  const env: Record<string, string> = {};
  for (const name of allow) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Same conversion as the engine's (kept local; dev tooling must not drift). */
function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) {
    return path.replaceAll('\\', '/');
  }
  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch === null) return path;
  const drive = driveMatch[1]!.toLowerCase();
  const rest = path.slice(2).replaceAll('\\', '/');
  return `/${drive}${rest}`;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

async function runBashScript(shellPath: string, script: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(shellPath, ['--noprofile', '--norc'], {
      env: sanitizedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`bash probe timed out after ${BASH_TIMEOUT_MS}ms`));
    }, BASH_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `bash probe exited ${code}: ${stderr.slice(0, 500)} ${stdout.slice(0, 500)}`,
          ),
        );
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

interface DeclEntry {
  readonly line: string;
  readonly flags: string;
}

/** `declare -p` prints exactly one line per variable (arrays included). */
function parseDecl(text: string): Map<string, DeclEntry> {
  const map = new Map<string, DeclEntry>();
  for (const line of text.split('\n')) {
    const match = /^declare -(\S+) ([^ =]+)/.exec(line);
    if (match === null) continue;
    map.set(match[2]!, { line, flags: match[1]! });
  }
  return map;
}

/**
 * A `declare -p` line with a real assignment vs a pre-declared-but-dynamic
 * entry: unset (`declare -- NAME`) or an empty array (`declare -a NAME=()`),
 * which bash materializes on first reference/context change (GROUPS,
 * DIRSTACK, BASH_ARGC, …).
 */
function hasDeclValue(line: string): boolean {
  return /^declare -\S+ \S+=/.test(line) && !line.endsWith('=()');
}

export async function detectShellStateFilter(
  shellPath: string,
): Promise<ShellStateFilterDetection> {
  const workDir = await mkdtemp(join(tmpdir(), 'kimi-shell-filter-'));
  const nodeBase = join(workDir, 'probe');
  // Git Bash needs posix paths; on POSIX hosts this is a no-op.
  const bashBase = windowsPathToPosixPath(nodeBase);
  try {
    const probeScript = [
      `printf 'KIMI_DETECT_VERSION %s\\n' "$BASH_VERSION"`,
      // Give OLDPWD a real value before snapA: it is pre-declared-unset in a
      // bash that never cd'd, which would trip the dynamic-variable rule —
      // but at runtime the tip always cd's, and OLDPWD is user state the
      // dump must keep (`cd -` across tool calls).
      'cd .',
      // snapA: top-level baseline capture (pipeline form — the same capture
      // shape the self-check and the runtime dump use, so context-sensitive
      // values are comparable across all three).
      `declare -p | sort > ${shellQuote(`${bashBase}.a.decl`)}`,
      // Force-reference the PRNGs (they only change when read), trigger a
      // regex match (BASH_REMATCH), and bridge a second boundary so
      // second-granularity vars (SECONDS, EPOCHSECONDS) flip.
      ': "$RANDOM" "$SRANDOM"',
      '[[ x =~ x ]]',
      'sleep 1',
      'read -r < /dev/null || :',
      // pushd exercises DIRSTACK but also rewrites OLDPWD — save/restore it:
      // OLDPWD is USER state the runtime dump must keep (it makes `cd -`
      // work across tool calls), so the probe must not mark it volatile.
      '__kimi_oldpwd="${OLDPWD-}"',
      'pushd . >/dev/null && popd >/dev/null',
      'OLDPWD="$__kimi_oldpwd"',
      // snapB: inside a function AND a deeper subshell — unmasks
      // function-context vars (FUNCNAME, BASH_ARGV/ARGC/LINENO/SOURCE) and
      // depth-sensitive vars (BASH_SUBSHELL). The distinctive pipeline first
      // unmasks PIPESTATUS, whose value depends on the last pipeline's exit
      // codes (constant across these two captures, per-command at runtime).
      '__kimi_probe() {',
      '  false | true',
      `  ( declare -p | sort > ${shellQuote(`${bashBase}.b.decl`)} )`,
      '}',
      '__kimi_probe',
      `printf 'KIMI_DETECT_DONE\\n'`,
      '',
    ].join('\n');
    const probeOut = await runBashScript(shellPath, probeScript);
    const version = /^KIMI_DETECT_VERSION (.*)$/m.exec(probeOut)?.[1] ?? 'unknown';
    if (!probeOut.includes('KIMI_DETECT_DONE')) {
      throw new Error('shell filter detection probe did not complete');
    }

    const a = parseDecl(await readFile(`${nodeBase}.a.decl`, 'utf8'));
    const b = parseDecl(await readFile(`${nodeBase}.b.decl`, 'utf8'));

    const readonlyNames: string[] = [];
    const volatileNames: string[] = [];
    const lazyNames: string[] = [];
    const names = new Set<string>([...a.keys(), ...b.keys()]);
    for (const name of names) {
      const ea = a.get(name);
      const eb = b.get(name);
      if (ea?.flags.includes('r') === true || eb?.flags.includes('r') === true) {
        readonlyNames.push(name);
      } else if (ea === undefined || eb === undefined) {
        // Created lazily (function-context, regex match, bare read, …).
        lazyNames.push(name);
      } else if (ea.line !== eb.line || !hasDeclValue(ea.line)) {
        // Line changed between captures — or the variable sits in bash's
        // variable table PRE-DECLARED but unset in both (`declare -- NAME`
        // with no value): those are dynamic variables bash materializes
        // later on first reference/context change (SECONDS, EPOCHREALTIME,
        // BASHPID, COMP_WORDBREAKS, …), and a dump that caught the unset
        // form would never be byte-stable. Treat both as volatile.
        volatileNames.push(name);
      }
    }
    // Defensive: the probe never creates protocol variables, but never let
    // one leak into the artifact if the probe script changes.
    const isProtocol = (name: string): boolean => /^__kimi_/i.test(name);
    const all = [...readonlyNames, ...volatileNames, ...lazyNames]
      .filter((name) => !isProtocol(name))
      .toSorted();
    const detection: ShellStateFilterDetection = {
      bashVersion: version,
      readonlyNames: readonlyNames.filter((name) => !isProtocol(name)).toSorted(),
      volatileNames: volatileNames.filter((name) => !isProtocol(name)).toSorted(),
      lazyNames: lazyNames.filter((name) => !isProtocol(name)).toSorted(),
      all,
      alternation: all.join('|'),
    };

    // Self-check: two simulated commit/absorb cycles filtered by the derived
    // regex must be byte-identical. A missed volatile/context var ratchets
    // (absorbed into the main shell, dumped with a new value next cycle) and
    // breaks the equality — refuse the artifact instead of shipping it.
    const nameFilterRe = `^declare -[-a-zA-Z]+ (${detection.alternation})(=| |$)`;
    const checkScript = [
      `__k_f=${shellQuote(nameFilterRe)}`,
      `( declare -p | sort | grep -vE "$__k_f" || : ) > ${shellQuote(`${bashBase}.d1`)}`,
      `source <(sed 's/^declare /declare -g /' ${shellQuote(`${bashBase}.d1`)})`,
      `( declare -p | sort | grep -vE "$__k_f" || : ) > ${shellQuote(`${bashBase}.d2`)}`,
      `cmp -s ${shellQuote(`${bashBase}.d1`)} ${shellQuote(`${bashBase}.d2`)} \\`,
      `  && printf 'KIMI_STABLE\\n' \\`,
      `  || { printf 'KIMI_UNSTABLE\\n'; diff ${shellQuote(`${bashBase}.d1`)} ${shellQuote(`${bashBase}.d2`)}; }`,
      // Always exit 0: the verdict travels on stdout, and a nonzero exit
      // would mask it as a generic probe failure.
      'true',
      '',
    ].join('\n');
    const checkOut = await runBashScript(shellPath, checkScript);
    if (!checkOut.includes('KIMI_STABLE')) {
      throw new Error(
        `shell filter self-check failed: filtered consecutive dumps differ ` +
          `(a bookkeeping variable escaped detection):\n${checkOut.slice(0, 2000)}`,
      );
    }
    return detection;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
