import { describe, expect, it } from 'vitest';

import { detectEnvironmentFromNode } from '#/environment';
import { detectShellStateFilter } from '#/stateful-shell/filterDetection';
import { SHELL_STATE_BOOKKEEPING_ALTS } from '#/stateful-shell/shellStateFilter.generated';

// The stateful-shell protocol's bookkeeping-variable exclusion filter is
// GENERATED (scripts/gen-shell-state-filter.mts), not hand-maintained: a bash
// update or a new backend that changes the set of shell-internal variables
// must fail here — loudly, at test time — instead of silently corrupting
// state dumps. Detection re-runs the live probe (readonly / volatile / lazy)
// and self-verifies byte-stability of two filtered commit/absorb cycles, so
// this single assertion covers both artifact drift and detection regressions.
describe('shell-state bookkeeping filter', () => {
  it('committed filter matches live bash detection (regenerate on failure)', async () => {
    const env = await detectEnvironmentFromNode();
    const detection = await detectShellStateFilter(env.shellPath);
    expect(
      detection.alternation,
      'shell bookkeeping variables drifted from the committed artifact — ' +
        'regenerate with: pnpm --filter @moonshot-ai/kaos gen:shell-state-filter',
    ).toBe(SHELL_STATE_BOOKKEEPING_ALTS);
  }, 30_000);
});
