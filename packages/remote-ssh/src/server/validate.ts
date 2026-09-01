/** Parameter validation helpers shared by the op handlers. */

import { isAbsolute } from 'node:path';

export class OpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpError';
    this.code = code;
  }
}

export function requireString(
  params: Record<string, unknown>,
  key: string,
  options?: { allowEmpty?: boolean },
): string {
  const value = params[key];
  if (typeof value !== 'string' || (value.length === 0 && options?.allowEmpty !== true)) {
    throw new OpError('EINVAL', `params.${key} must be a${options?.allowEmpty === true ? '' : ' non-empty'} string`);
  }
  return value;
}

/**
 * Absolute-path variant of `requireString`, judged with the server's own
 * platform semantics. The fs contract is exec-side absolute paths only:
 * accepting a relative path would silently resolve it against the RTS
 * process cwd (the remote home), writing or reading an unintended tree.
 */
export function requireAbsolutePath(params: Record<string, unknown>, key: string): string {
  const value = requireString(params, key);
  if (!isAbsolute(value)) {
    throw new OpError('EINVAL', `params.${key} must be an absolute path (got "${value}")`);
  }
  return value;
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OpError('EINVAL', `params.${key} must be a string`);
  }
  return value;
}

/** Optional counterpart of `requireAbsolutePath`. */
export function optionalAbsolutePath(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = optionalString(params, key);
  if (value !== undefined && !isAbsolute(value)) {
    throw new OpError('EINVAL', `params.${key} must be an absolute path (got "${value}")`);
  }
  return value;
}

export function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new OpError('EINVAL', `params.${key} must be a boolean`);
  }
  return value;
}

export function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new OpError('EINVAL', `params.${key} must be a non-negative integer`);
  }
  return value;
}

export function optionalEncoding(params: Record<string, unknown>, key: string): BufferEncoding | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Buffer.isEncoding(value)) {
    throw new OpError('EINVAL', `params.${key} must be a valid encoding`);
  }
  return value;
}

export function requireStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new OpError('EINVAL', `params.${key} must be an array of strings`);
  }
  return value as string[];
}

export function optionalEnv(params: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpError('EINVAL', `params.${key} must be an object of string values`);
  }
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new OpError('EINVAL', `params.${key}.${name} must be a string`);
    }
    env[name] = entry;
  }
  return env;
}
