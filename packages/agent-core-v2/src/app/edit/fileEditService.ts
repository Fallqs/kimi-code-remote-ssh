import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { isTextDecodeError, notReadableTextMessage } from '#/_base/text/fileView';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { EditService } from './editService';
import { type FileEditInput, type FileEditResult, IFileEditService } from './fileEdit';
import { TextModel } from './textModel';

export class FileEditService implements IFileEditService {
  declare readonly _serviceBrand: undefined;

  private readonly editor: EditService;

  constructor(@IHostFileSystem private readonly fs: IHostFileSystem) {
    this.editor = new EditService();
  }

  async edit(input: FileEditInput, fs: IHostFileSystem = this.fs): Promise<FileEditResult> {
    try {
      const raw = await fs.readText(input.path, { errors: 'strict' });
      if (raw.includes('\u0000')) {
        return { ok: false, error: notReadableTextMessage(input.displayPath) };
      }
      const model = new TextModel(raw);
      const result = this.editor.apply(model, {
        path: input.displayPath,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      await fs.writeText(input.path, result.rawContent);
      return { ok: true, count: result.count, normalizations: result.normalizations };
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { ok: false, error: `${input.displayPath} is not a file.` };
      }
      if (isTextDecodeError(error)) {
        return { ok: false, error: notReadableTextMessage(input.displayPath) };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IFileEditService,
  FileEditService,
  ScopeActivation.OnScopeCreated,
  'edit',
);
