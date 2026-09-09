'use client';
import { useEffect, useState } from 'react';
import { ChevronDown, Download, FileAudio, FileText } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { SavedRecording } from '../server/archive';
import { languageLabel } from '@/shared/languages';
const time = (n: number) =>
  Math.floor(n / 60)
    .toString()
    .padStart(2, '0') +
  ':' +
  Math.floor(n % 60)
    .toString()
    .padStart(2, '0');
export function RecordingHistory({ state }: { state: string }) {
  const [items, setItems] = useState<SavedRecording[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    async function load() {
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
          setError('');
        }
      } catch {
        if (!disposed) setError('暂时无法读取历史录音，请检查本地服务连接。');
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
  }, [state]);
  return (
    <section className="history-panel" aria-labelledby="history-heading">
      <div className="history-heading">
        <div>
          <span className="section-number">03</span>
          <h2 id="history-heading">已保存的录音</h2>
        </div>
        <span>音频与文本一一对应</span>
      </div>
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
            className="history-record"
            key={item.id}
            defaultOpen={index === 0}
          >
            <div className="history-record-top">
              <div>
                <h3>
                  {new Date(item.startedAt).toLocaleString('zh-CN', {
                    hour12: false,
                  })}
                </h3>
                <p>
                  {time(item.samples / 16000)} <span>·</span>{' '}
                  {item.segments.length} 个语音片段 <span>·</span>{' '}
                  {item.status === 'recording'
                    ? '正在保存'
                    : item.status === 'complete'
                      ? '已保存'
                      : '已保存中断前的内容'}
                </p>
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
    </section>
  );
}
