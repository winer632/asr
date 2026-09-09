export const MAX_DELETE_RECORDINGS = 50;

export interface DeleteRecordingsResult {
  deletedIds: string[];
  missingIds: string[];
  failed: {
    id: string;
    code: 'recording_active' | 'invalid_recording' | 'delete_failed';
    message: string;
  }[];
}
