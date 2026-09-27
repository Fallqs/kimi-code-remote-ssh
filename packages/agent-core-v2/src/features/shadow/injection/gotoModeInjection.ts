import { Service } from '#/_base/di/service';
import { defineState } from '#/state/state';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import { IAgentGotoModeService } from '../shadow';
import GOTO_MODE_EXIT_REMINDER from './goto-mode-exit-reminder.md?raw';
import GOTO_MODE_FULL_REMINDER from './goto-mode-full-reminder.md?raw';
import GOTO_MODE_SPARSE_REMINDER from './goto-mode-sparse-reminder.md?raw';

const GOTO_MODE_DEDUP_MIN_TURNS = 2;
const GOTO_MODE_FULL_REFRESH_TURNS = 5;
const GOTO_MODE_INJECTION_VARIANT = 'shadow_mode';
const GOTO_WORKDIR_PLACEHOLDER = '$GOTO_WORKDIR';

export const gotoWasActiveKey = defineState<boolean>('goto.wasActive', () => false);

export class GotoModeInjection extends Service {
  constructor(
    injector: IAgentReminderService,
    private readonly gotoMode: Pick<IAgentGotoModeService, 'status'>,
    private readonly context: IAgentContextMemoryService,
    private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(gotoWasActiveKey);

    this._register(
      injector.register(GOTO_MODE_INJECTION_VARIANT, async ({ lastInjectedAt: injectedAt }) => {
        const status = await this.gotoMode.status();
        if (status === null) {
          if (!this.states.get(gotoWasActiveKey)) return undefined;
          this.states.set(gotoWasActiveKey, false);
          return GOTO_MODE_EXIT_REMINDER;
        }
        if (!this.states.get(gotoWasActiveKey)) {
          this.states.set(gotoWasActiveKey, true);
          return withWorkDir(GOTO_MODE_FULL_REMINDER, status.workDir);
        }
        const variant = gotoModeReminderVariant(injectedAt, this.context.get());
        if (variant === 'full') return withWorkDir(GOTO_MODE_FULL_REMINDER, status.workDir);
        if (variant === 'sparse') return withWorkDir(GOTO_MODE_SPARSE_REMINDER, status.workDir);
        return undefined;
      }),
    );
  }
}

type GotoModeReminderVariant = 'full' | 'sparse';

function gotoModeReminderVariant(
  injectedAt: number | null,
  history: readonly ContextMessage[],
): GotoModeReminderVariant | null {
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
  if (assistantTurnsSince >= GOTO_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= GOTO_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}

function withWorkDir(body: string, workDir: string): string {
  return body.replaceAll(GOTO_WORKDIR_PLACEHOLDER, workDir);
}
