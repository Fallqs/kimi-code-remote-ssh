import {
  Error2,
  IAgentLifecycleService,
  IAgentShellCommandService,
  isError2,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ulid } from 'ulid';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { resumeSessionForClient } from '../shadowAlias';
import { ErrorCode } from '../protocol/error-codes';
import {
  runShellCommandRequestSchema,
  runShellCommandResultSchema,
} from '../protocol/rest-shell';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';

interface ShellRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

async function resolveSession(core: Scope, sessionId: string): Promise<ISessionScopeHandle> {
  const session = await resumeSessionForClient(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2('session.not_found', `session ${sessionId} does not exist`);
  }
  return session;
}

async function resolveShellAgent(session: ISessionScopeHandle, agentId?: string) {
  const agent =
    agentId === undefined || agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : session.accessor.get(IAgentLifecycleService).handleOf(agentId);
  if (agent === undefined) {
    throw new Error2('agent.not_found', `agent ${agentId} does not exist`);
  }
  return agent;
}

export function registerShellRoutes(app: ShellRouteHost, core: Scope): void {
  const runRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/shell',
      params: sessionIdParamSchema,
      body: runShellCommandRequestSchema,
      success: { data: runShellCommandResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Run a one-shot `!` shell command in a session',
      tags: ['shell'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const session = await resolveSession(core, session_id);
        const agent = await resolveShellAgent(session, req.body.agent_id);
        const commandId = req.body.command_id ?? ulid();
        const result = await agent.accessor
          .get(IAgentShellCommandService)
          .run({ command: req.body.command, commandId });
        reply.send(
          okEnvelope(
            {
              command_id: commandId,
              stdout: result.stdout,
              stderr: result.stderr,
              is_error: result.isError,
              backgrounded: result.backgrounded,
            },
            req.id,
          ),
        );
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    runRoute.path,
    runRoute.options,
    runRoute.handler as Parameters<ShellRouteHost['post']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
    }
  }
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}
