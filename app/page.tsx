'use client';
import {
  AudioLines,
  ArrowUpRight,
  Check,
  Copy,
  Mic,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRecorder } from '@/lib/use-recorder';
import { RecordingHistory } from '@/components/recording-history';
import { LANGUAGES, findLanguage, languageLabel } from '@/shared/languages';
const time = (n: number) =>
  Math.floor(n / 60)
    .toString()
    .padStart(2, '0') +
  ':' +
  Math.floor(n % 60)
    .toString()
    .padStart(2, '0');
export default function Home() {
  const { bottomRef, ...r } = useRecorder();
  const active = r.status === 'recording',
    busy = r.status === 'connecting' || r.status === 'stopping';
  const label = {
    idle: '准备就绪',
    connecting: '正在连接',
    recording: r.speaking ? '正在聆听' : '等待说话',
    stopping: '正在完成识别',
    error: '连接中断',
  }[r.status];
  const latest = r.segments.at(-1);
  const latestLanguage = findLanguage(latest?.language || '');
  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="/" className="brand">
          <span className="brand-mark">
            <AudioLines size={23} />
          </span>
          声迹 <span>ASR</span>
        </a>
        <a className="docs-link" href="/asr-api.html">
          接口文档 <ArrowUpRight size={16} />
        </a>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">VOICE WORKSPACE</p>
            <h1>让对话成为文字</h1>
            <p className="subtitle">连续录音，自动识别多种语言。</p>
          </div>
          <span className={'status-pill ' + (active ? 'active' : '')}>
            <i />
            {label}
          </span>
        </div>
        <div className="workspace-grid">
          <section
            className="transcript-panel"
            aria-labelledby="transcript-heading"
          >
            <div className="panel-heading">
              <div>
                <span className="section-number">01</span>
                <h2 id="transcript-heading">识别记录</h2>
                <span className="count">
                  {r.segments.filter((s) => s.final).length} 段
                </span>
              </div>
              <Button
                variant="ghost"
                className="copy-button"
                disabled={!r.segments.some((s) => s.text)}
                onClick={r.copy}
              >
                {r.copied ? <Check /> : <Copy />}
                {r.copied ? '已复制' : '复制文字'}
              </Button>
            </div>
            <div
              className="transcript-scroll"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {!r.segments.length ? (
                <div className="empty-transcript">
                  <span className="empty-icon">
                    <AudioLines size={34} strokeWidth={1.4} />
                  </span>
                  <h3>{active ? '正在等你开口' : '从第一句话开始'}</h3>
                  <p>
                    {active
                      ? '自然说话，识别的文字会持续显示在这里。'
                      : '点击「开始录音」，说话时自动出字，停顿时自动分段。'}
                  </p>
                  <span className="empty-languages">
                    已实测 {LANGUAGES.length} 种语言 <i /> 自动识别
                  </span>
                </div>
              ) : (
                r.segments.map((s, i) => (
                  <article
                    className={
                      'transcript-entry ' + (s.final ? '' : 'provisional')
                    }
                    key={s.id}
                  >
                    <div className="entry-meta">
                      <span>{String(i + 1).padStart(2, '0')}</span>
                      <time>{time(s.startMs / 1000)}</time>
                      <span className="language-tag">
                        {languageLabel(
                          s.language,
                          s.final ? '未检测到语种' : '检测语种中',
                        )}
                      </span>
                      <span className="entry-state">
                        {s.error ? '识别失败' : s.final ? '已完成' : '识别中'}
                      </span>
                    </div>
                    <p>
                      {s.text ||
                        s.error ||
                        (s.final
                          ? '这段语音未识别出文字。'
                          : '正在识别这段语音…')}
                      {!s.final && !s.error && <span className="text-caret" />}
                    </p>
                  </article>
                ))
              )}
              <div ref={bottomRef} />
            </div>
            <footer className="transcript-footer">
              <span className={'signal-dot ' + (active ? 'active' : '')} />
              {active
                ? '音频和文字正在自动保存到本地服务'
                : '音频与文字自动保存，可在下方历史记录中下载'}
            </footer>
          </section>
          <aside className="recording-panel">
            <div className="recorder-top">
              <span className="section-number">02</span>
              <h2>录音控制</h2>
            </div>
            <div
              className={
                'mic-orbit ' +
                (active ? 'recording ' : '') +
                (r.speaking ? 'speaking' : '')
              }
            >
              <Mic size={36} strokeWidth={1.5} />
            </div>
            <div className="recording-time" aria-label="录音时长">
              {time(r.elapsed)}
            </div>
            <p className="recorder-state">{label}</p>
            <meter
              className="sr-only"
              aria-label="麦克风音量"
              min={0}
              max={100}
              value={Math.round(r.level * 100)}
            />
            <div className="audio-meter" aria-hidden="true">
              {Array.from({ length: 32 }, (_, i) => (
                <span
                  key={i}
                  style={{
                    height: 7 + Math.sin(i * 1.7) ** 2 * 29 + 'px',
                    opacity: active && i < r.level * 32 ? 1 : 0.16,
                  }}
                />
              ))}
            </div>
            <Button
              className={'record-button ' + (active ? 'stop' : '')}
              disabled={busy}
              onClick={active ? r.stop : r.start}
            >
              {busy ? null : active ? (
                <Square size={17} fill="currentColor" />
              ) : (
                <Mic size={19} />
              )}{' '}
              {busy ? label : active ? '停止录音' : '开始录音'}
            </Button>
            <p className="record-hint">
              {active
                ? '保持页面在前台，结束时点击停止。'
                : '首次使用需要允许访问麦克风。'}
            </p>
            {r.error && (
              <div className="error-message" role="alert">
                {r.error}
              </div>
            )}
            <div className="language-summary">
              <span>自动检测语种</span>
              <strong>
                {languageLabel(latest?.language || '', '等待语音')}
              </strong>
              <div className="language-chips">
                {LANGUAGES.map((language) => (
                  <span
                    className={latestLanguage === language ? 'selected' : ''}
                    title={
                      language.declared ? '服务声明支持' : '实测可自动识别'
                    }
                    key={language.code}
                  >
                    {language.label}
                  </span>
                ))}
              </div>
              <p className="language-hint">
                已实测 {LANGUAGES.length} 种语言，无需手动切换。
              </p>
            </div>
            <div className="recording-note">
              <span className="note-dot" />
              <p>
                说话时持续更新文字
                <br />
                停顿后自动完成当前句
              </p>
            </div>
          </aside>
        </div>
        <RecordingHistory state={r.status} />
        <footer className="page-footer">
          <span>声迹 · 连续语音识别</span>
          <span>
            VAD 语音检测 <i /> 多语自动识别
          </span>
        </footer>
      </main>
    </div>
  );
}
