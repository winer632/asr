import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_DELETE_RECORDINGS,
  type DeleteRecordingsResult,
} from '../shared/recordings.js';

export function deletionIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_DELETE_RECORDINGS ||
    !value.every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    )
  )
    throw new Error('请选择 1–50 条有效的录音记录。');
  return [...new Set(value as string[])];
}

export async function deleteRecordings(
  root: string,
  requestedIds: unknown,
): Promise<DeleteRecordingsResult> {
  // Validate the whole request before changing any files.
  const ids = deletionIds(requestedIds);
  const result: DeleteRecordingsResult = {
    deletedIds: [],
    missingIds: [],
    failed: [],
  };
  for (const id of ids) {
    const directory = path.join(root, id);
    try {
      const entry = await lstat(directory);
      const manifestPath = path.join(directory, 'manifest.json');
      // Never follow a recording directory or manifest symlink for deletion.
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('invalid_recording');
      let manifest: { id?: unknown; status?: unknown };
      try {
        const manifestEntry = await lstat(manifestPath);
        if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink())
          throw new Error();
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (!manifest || manifest.id !== id) throw new Error();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Another delete request may have removed this recording meanwhile.
          await lstat(directory);
        }
        throw new Error('invalid_recording');
      }
      if (manifest.status === 'recording') {
        result.failed.push({
          id,
          code: 'recording_active',
          message: '这条录音仍在进行中，请结束录音后再删除。',
        });
        continue;
      }
      if (manifest.status !== 'complete' && manifest.status !== 'interrupted')
        throw new Error('invalid_recording');
      // rm removes nested symlinks themselves, not the files they point to.
      await rm(directory, { recursive: true, maxRetries: 2, retryDelay: 50 });
      result.deletedIds.push(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.missingIds.push(id);
      } else if ((error as Error).message === 'invalid_recording') {
        result.failed.push({
          id,
          code: 'invalid_recording',
          message: '录音目录或清单异常，未执行删除。',
        });
      } else {
        result.failed.push({
          id,
          code: 'delete_failed',
          message: '删除未完成，请检查目录权限后重试。',
        });
      }
    }
  }
  return result;
}
