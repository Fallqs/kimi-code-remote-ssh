import { z } from 'zod';

export const runShellCommandRequestSchema = z.object({
  command: z.string().min(1),
  command_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
});
export type RunShellCommandRequest = z.infer<typeof runShellCommandRequestSchema>;

export const runShellCommandResultSchema = z.object({
  command_id: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  is_error: z.boolean().optional(),
  backgrounded: z.boolean().optional(),
});
export type RunShellCommandResult = z.infer<typeof runShellCommandResultSchema>;
