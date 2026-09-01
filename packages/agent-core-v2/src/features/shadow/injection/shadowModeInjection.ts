import { Service } from '#/_base/di/service';
import { defineState } from '#/state/state';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import { IAgentShadowModeService } from '../shadow';
import SHADOW_MODE_EXIT_REMINDER from './shadow-mode-exit-reminder.md?raw';
import SHADOW_MODE_FULL_REMINDER from './shadow-mode-full-reminder.md?raw';
import SHADOW_MODE_SPARSE_REMINDER from './shadow-mode-sparse-reminder.md?raw';

const SHADOW_MODE_DEDUP_MIN_TURNS = 2;
const SHADOW_MODE_FULL_REFRESH_TURNS = 5;
const SHADOW_MODE_INJECTION_VARIANT = 'shadow_mode';

export const shadowWasActiveKey = defineState<boolean>('shadow.wasActive', () => false);

export class ShadowModeInjection extends Service {
  constructor(
    injector: IAgentReminderService,
    private readonly shadow: Pick<IAgentShadowModeService, 'status'>,
    private readonly context: IAgentContextMemoryService,
    private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(shadowWasActiveKey);

    this._register(
      injector.register(SHADOW_MODE_INJECTION_VARIANT, async ({ lastInjectedAt: injectedAt }) => {
        const status = await this.shadow.status();
        if (status === null) {
          if (!this.states.get(shadowWasActiveKey)) return undefined;
          this.states.set(shadowWasActiveKey, false);
          return SHADOW_MODE_EXIT_REMINDER;
        }
        if (!this.states.get(shadowWasActiveKey)) {
          this.states.set(shadowWasActiveKey, true);
          return withWorkDirFooter(SHADOW_MODE_FULL_REMINDER, status.workDir);
        }
        const variant = shadowModeReminderVariant(injectedAt, this.context.get());
        if (variant === 'full') return withWorkDirFooter(SHADOW_MODE_FULL_REMINDER, status.workDir);
        if (variant === 'sparse')
          return withWorkDirFooter(SHADOW_MODE_SPARSE_REMINDER, status.workDir);
        return undefined;
      }),
    );
  }
}

type ShadowModeReminderVariant = 'full' | 'sparse';

function shadowModeReminderVariant(
  injectedAt: number | null,
  history: readonly ContextMessage[],
): ShadowModeReminderVariant | null {
  if (injectedAt === null) return 'full';
  let assistantTurnsSince = 0;
  for (let i = injectedAt + 1; i < history.length; i++) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.role === 'assistant') {
      assistantTurnsSince += 1;
      continue;
    }
    if (message.role === 'user') {
      return 'full';
    }
  }
  if (assistantTurnsSince >= SHADOW_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= SHADOW_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}

function withWorkDirFooter(body: string, workDir: string): string {
  return `${body}\n\nShadow workdir: ${workDir}`;
}
