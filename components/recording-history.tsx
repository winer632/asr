'use client';
import { useEffect, useState } from 'react';
import {
  ChevronDown,
  Download,
  FileAudio,
  FileText,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { SavedRecording } from '../server/archive';
import { languageLabel } from '@/shared/languages';
import type { DeleteRecordingsResult } from '@/shared/recordings';
const time = (n: number) =>
  Math.floor(n / 60)
    .toString()
    .padStart(2, '0') +
  ':' +
  Math.floor(n % 60)
    .toString()
    .padStart(2, '0');
const dateLabel = (item: SavedRecording) =>
  new Date(item.startedAt).toLocaleString('zh-CN', { hour12: false });
export function RecordingHistory({ state }: { state: string }) {
  const [items, setItems] = useState<SavedRecording[]>([]),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]),
    [pendingDelete, setPendingDelete] = useState<SavedRecording[] | null>(null),
    [deleting, setDeleting] = useState(false),
    [deleteError, setDeleteError] = useState(''),
    [notice, setNotice] = useState('');
  const selectable = items.filter((item) => item.status !== 'recording');
  const selectedItems = selectable.filter((item) => selected.includes(item.id));
  const allSelected =
    selectable.length > 0 && selectedItems.length === selectable.length;
  const someSelected = selectedItems.length > 0 && !allSelected;
  useEffect(() => {
    if (deleting) return;
    let disposed = false,
      loading = false;
    const controller = new AbortController();
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch('/api/recordings', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error();
        const data = (await response.json()) as {
          recordings: SavedRecording[];
        };
        if (!disposed) {
          setItems(data.recordings);
          setSelected((previous) =>
            previous.filter((id) =>
              data.recordings.some(
                (item) => item.id === id && item.status !== 'recording',
              ),
            ),
          );
          setError('');
        }
      } catch {
        if (!disposed) setError('暂时无法读取历史录音，请检查本地服务连接。');
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [state, deleting]);
  function toggle(id: string, checked: boolean) {
    setSelected((previous) =>
      checked
        ? [...new Set([...previous, id])]
        : previous.filter((value) => value !== id),
    );
  }
  function confirmDelete(records: SavedRecording[]) {
    if (!records.length || deleting) return;
    setDeleteError('');
    setNotice('');
    setPendingDelete(records);
  }
  async function removeSelected() {
    if (!pendingDelete?.length || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const response = await fetch('/api/recordings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: pendingDelete.map((item) => item.id) }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await response.json()) as DeleteRecordingsResult & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || '删除请求失败，请重试。');
      if (
        !Array.isArray(data.deletedIds) ||
        !Array.isArray(data.missingIds) ||
        !Array.isArray(data.failed)
      )
        throw new Error('删除结果无法确认，请刷新列表后核对。');
      const removed = new Set([...data.deletedIds, ...data.missingIds]);
      setItems((previous) => previous.filter((item) => !removed.has(item.id)));
      setSelected((previous) => previous.filter((id) => !removed.has(id)));
      setNotice(
        [
          data.deletedIds.length
            ? `已删除 ${data.deletedIds.length} 条录音及对应音频、文本。`
            : '',
          data.missingIds.length
            ? `${data.missingIds.length} 条录音已不存在，列表已同步。`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      if (data.failed.length)
        setDeleteError(
          `有 ${data.failed.length} 条录音未删除：` +
            [...new Set(data.failed.map((failure) => failure.message))].join(
              ' ',
            ),
        );
      setPendingDelete(null);
    } catch (failure) {
      setDeleteError(
        failure instanceof TypeError
          ? '无法连接录音服务，请检查网络后重试。'
          : failure instanceof SyntaxError
            ? '删除结果无法确认，请刷新列表后核对。'
            : failure instanceof Error && failure.name !== 'TimeoutError'
              ? failure.message
              : '删除请求超时，请关闭对话框并核对刷新后的列表，再重试。',
      );
    } finally {
      setDeleting(false);
    }
  }
  return (
    <section className="history-panel" aria-labelledby="history-heading">
      <div className="history-heading">
        <div>
          <span className="section-number">03</span>
          <h2 id="history-heading">已保存的录音</h2>
        </div>
        <span>音频与文本一一对应</span>
      </div>
      {items.length > 0 && (
        <div className="history-toolbar">
          <div className="history-selection">
            <label
              className="history-select-all"
              htmlFor="select-saved-recordings"
            >
              <Checkbox
                id="select-saved-recordings"
                aria-label="全选当前列表中可删除的录音"
                checked={allSelected}
                indeterminate={someSelected}
                disabled={deleting || !selectable.length}
                onCheckedChange={(checked) =>
                  setSelected(checked ? selectable.map((item) => item.id) : [])
                }
              />
              全选当前列表
            </label>
            <span aria-live="polite">已选 {selectedItems.length} 条</span>
          </div>
          <Button
            variant="destructive"
            className="history-delete-button"
            disabled={deleting || !selectedItems.length}
            onClick={() => confirmDelete(selectedItems)}
          >
            <Trash2 size={16} /> 删除所选
          </Button>
        </div>
      )}
      {notice && <output className="history-notice">{notice}</output>}
      {deleteError && !pendingDelete && (
        <p className="history-error" role="alert">
          {deleteError}
        </p>
      )}
      {error && <output className="history-error">{error}</output>}
      {!items.length && !error && (
        <p className="history-empty">
          录音会自动保存到本地服务，结束后可在这里下载音频和文字。
        </p>
      )}
      {items.map((item, index) => {
        const base = '/api/recordings/' + encodeURIComponent(item.id);
        return (
          <Collapsible
            className={
              'history-record' + (selected.includes(item.id) ? ' selected' : '')
            }
            key={item.id}
            defaultOpen={index === 0}
          >
            <div className="history-record-top">
              <div className="history-record-identity">
                <label
                  className="history-record-check"
                  htmlFor={'select-recording-' + item.id}
                >
                  <Checkbox
                    id={'select-recording-' + item.id}
                    aria-label={`选择 ${dateLabel(item)} 的录音（${item.id.slice(-8)}）`}
                    checked={selected.includes(item.id)}
                    disabled={deleting || item.status === 'recording'}
                    onCheckedChange={(checked) => toggle(item.id, checked)}
                  />
                </label>
                <div>
                  <h3>{dateLabel(item)}</h3>
                  <p>
                    {time(item.samples / 16000)} <span>·</span>{' '}
                    {item.segments.length} 个语音片段 <span>·</span>{' '}
                    {item.status === 'recording'
                      ? '正在保存 · 结束后可删除'
                      : item.status === 'complete'
                        ? '已保存'
                        : '已保存中断前的内容'}
                  </p>
                </div>
              </div>
              <div className="download-pair">
                {item.status !== 'recording' ? (
                  <a href={base + '/audio'} download>
                    <FileAudio size={16} />
                    完整音频
                  </a>
                ) : (
                  <span>音频保存中</span>
                )}
                <a href={base + '/text'} download>
                  <FileText size={16} />
                  完整文本
                </a>
                <Button
                  variant="ghost"
                  className="history-delete-one"
                  aria-label={`删除 ${dateLabel(item)} 的录音（${item.id.slice(-8)}）`}
                  title={
                    item.status === 'recording'
                      ? '结束录音后可以删除'
                      : '删除这条录音'
                  }
                  disabled={deleting || item.status === 'recording'}
                  onClick={() => confirmDelete([item])}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
            </div>
            <div className="record-id">录音编号：{item.id}</div>
            <CollapsibleTrigger className="segment-toggle">
              查看 {item.segments.length} 组对应文件 <ChevronDown size={16} />
            </CollapsibleTrigger>
            <CollapsibleContent className="saved-segments">
              {item.segments.length ? (
                item.segments.map((segment) => (
                  <div className="saved-segment" key={segment.id}>
                    <div>
                      <strong>
                        {String(segment.sequence).padStart(3, '0')}
                      </strong>
                      <span>
                        {time(segment.startMs / 1000)} –{' '}
                        {time(segment.endMs / 1000)}
                      </span>
                      <span>{languageLabel(segment.language, '待识别')}</span>
                      {segment.status !== 'complete' && (
                        <span className="incomplete-label">
                          {segment.status === 'recognizing'
                            ? '识别中'
                            : '未完成'}
                        </span>
                      )}
                    </div>
                    <p>
                      {segment.text ||
                        segment.error ||
                        (segment.status === 'complete'
                          ? '这段语音未识别出文字。'
                          : '等待识别结果…')}
                    </p>
                    <div className="download-pair">
                      {segment.status === 'recognizing' ? (
                        <span>音频保存中</span>
                      ) : (
                        <a
                          href={
                            base + '/segments/' + segment.sequence + '/audio'
                          }
                          download
                        >
                          <Download size={14} />
                          {String(segment.sequence).padStart(3, '0')}.wav
                        </a>
                      )}
                      <a
                        href={base + '/segments/' + segment.sequence + '/text'}
                        download
                      >
                        <Download size={14} />
                        {String(segment.sequence).padStart(3, '0')}.txt
                      </a>
                    </div>
                  </div>
                ))
              ) : (
                <p>此录音尚未检测到语音片段。</p>
              )}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent className="recording-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除 {pendingDelete?.length || 0} 条录音？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将同时删除完整音频、文字稿和所有分段文件。删除后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="recording-delete-list">
            {pendingDelete?.map((item) => (
              <li key={item.id}>
                <strong>{dateLabel(item)}</strong>
                <span>
                  {time(item.samples / 16000)} · {item.segments.length} 段 ·{' '}
                  {item.id.slice(-8)}
                </span>
              </li>
            ))}
          </ul>
          {deleteError && (
            <p className="recording-delete-error" role="alert">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                void removeSelected();
              }}
            >
              {deleting ? '正在删除…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
