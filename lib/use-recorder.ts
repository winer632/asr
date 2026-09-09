import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerEvent, Transcript } from '../shared/protocol';
type Status = 'idle' | 'connecting' | 'recording' | 'stopping' | 'error';
interface Resources {
  context: AudioContext;
  stream?: MediaStream;
  processor?: AudioWorkletNode;
  source?: MediaStreamAudioSourceNode;
  gain?: GainNode;
  socket?: WebSocket;
  timeout?: ReturnType<typeof setTimeout>;
  flush?: () => void;
  offset: number;
  started: number;
}
export function useRecorder() {
  const [status, setStatus] = useState<Status>('idle'),
    statusRef = useRef<Status>('idle');
  const [segments, setSegments] = useState<Transcript[]>([]);
  const [speaking, setSpeaking] = useState(false),
    [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0),
    elapsedRef = useRef(0);
  const [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const resources = useRef<Resources | undefined>(undefined),
    mounted = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const transition = (value: Status) => {
    statusRef.current = value;
    if (mounted.current) setStatus(value);
  };
  const releaseAudio = (r: Resources) => {
    r.stream?.getTracks().forEach((track) => track.stop());
    r.processor?.disconnect();
    r.source?.disconnect();
    r.gain?.disconnect();
    if (r.context.state !== 'closed') void r.context.close().catch(() => {});
  };
  const cleanup = () => {
    const r = resources.current;
    resources.current = undefined;
    if (!r) return;
    clearTimeout(r.timeout);
    releaseAudio(r);
    r.socket?.close();
    if (mounted.current) {
      setSpeaking(false);
      setLevel(0);
    }
  };
  const fail = (message: string) => {
    if (!mounted.current) return;
    const r = resources.current;
    if (r?.started && statusRef.current === 'recording')
      elapsedRef.current = r.offset + (Date.now() - r.started) / 1000;
    setElapsed(elapsedRef.current);
    setError(message);
    setSegments((previous) =>
      previous.map((s) =>
        s.final
          ? s
          : { ...s, error: s.error || '未收到最终结果，请核对这段文字。' },
      ),
    );
    transition('error');
    cleanup();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanup();
    };
    // Resources are held in refs and disposed once per mount, including HMR.
  }, []);
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => {
      const r = resources.current;
      if (r?.started) setElapsed(r.offset + (Date.now() - r.started) / 1000);
    }, 250);
    return () => clearInterval(timer);
  }, [status]);
  useEffect(() => {
    const container = bottomRef.current?.parentElement;
    if (
      container &&
      container.scrollHeight - container.scrollTop - container.clientHeight <
        200
    )
      bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [segments]);
  const start = async () => {
    if (
      statusRef.current === 'recording' ||
      statusRef.current === 'connecting' ||
      statusRef.current === 'stopping'
    )
      return;
    cleanup();
    setError('');
    transition('connecting');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      fail(
        '浏览器需要安全连接才能录音。请使用本机 localhost，或使用已信任证书的 HTTPS 地址。',
      );
      return;
    }
    let r: Resources | undefined;
    try {
      const context = new AudioContext();
      const resume = context.resume();
      r = { context, offset: elapsedRef.current, started: 0 };
      resources.current = r;
      const current = r;
      r.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (resources.current !== r) {
        releaseAudio(r);
        return;
      }
      await resume;
      await context.audioWorklet.addModule('/audio-worklet.js');
      if (resources.current !== r) {
        releaseAudio(r);
        return;
      }
      const processor = (r.processor = new AudioWorkletNode(
        context,
        'pcm-capture',
      ));
      const source = (r.source = context.createMediaStreamSource(r.stream));
      const gain = (r.gain = context.createGain());
      gain.gain.value = 0;
      const url = new URL('/api/live', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = (r.socket = new WebSocket(url));
      ws.binaryType = 'arraybuffer';
      r.timeout = setTimeout(() => {
        if (resources.current === current)
          fail('连接录音服务超时，请确认本地服务正在运行。');
      }, 15_000);
      processor.port.onmessage = (event) => {
        if (resources.current !== current) return;
        if (event.data.type === 'flushed') {
          current.flush?.();
          return;
        }
        if (event.data.type === 'audio' && ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > 320_000) {
            fail('网络传输速度不足，录音已停止。请检查连接后重试。');
            return;
          }
          ws.send(event.data.pcm);
          if (mounted.current)
            setLevel(Math.min(1, Math.sqrt(event.data.rms) * 2.8));
        }
      };
      processor.onprocessorerror = () => {
        if (resources.current === current)
          fail('浏览器音频处理器意外停止，请重新开始录音。');
      };
      r.stream.getTracks().forEach((track) =>
        track.addEventListener('ended', () => {
          if (
            resources.current === current &&
            statusRef.current === 'recording'
          )
            fail('麦克风已断开，请检查设备后重新开始。');
        }),
      );
      context.addEventListener('statechange', () => {
        if (
          resources.current === current &&
          statusRef.current === 'recording' &&
          context.state !== 'running'
        )
          fail('浏览器暂停了音频采集，请保持页面在前台并重新开始。');
      });
      ws.onopen = () => ws.send(JSON.stringify({ type: 'start' }));
      ws.onmessage = (event) => {
        if (resources.current !== current) return;
        let message: ServerEvent;
        try {
          message = JSON.parse(event.data);
        } catch {
          fail('录音服务返回了无法解析的消息。');
          return;
        }
        if (message.type === 'ready') {
          clearTimeout(current.timeout);
          source.connect(processor);
          processor.connect(gain);
          gain.connect(context.destination);
          current.started = Date.now();
          transition('recording');
        } else if (message.type === 'vad') setSpeaking(message.speaking);
        else if (message.type === 'segment')
          setSegments((previous) => [
            ...previous,
            {
              id: message.id,
              startMs: message.startMs + current.offset * 1000,
              language: '',
              text: '',
              final: false,
            },
          ]);
        else if (message.type === 'partial' || message.type === 'final')
          setSegments((previous) =>
            previous.map((s) =>
              s.id === message.id
                ? {
                    ...s,
                    text: message.text,
                    language: message.language,
                    final: message.type === 'final',
                    error: undefined,
                  }
                : s,
            ),
          );
        else if (message.type === 'error') {
          if (message.id)
            setSegments((previous) =>
              previous.map((s) =>
                s.id === message.id ? { ...s, error: message.message } : s,
              ),
            );
          if (message.fatal) fail(message.message);
          else setError(message.message);
        } else if (message.type === 'stopped') {
          cleanup();
          transition('idle');
        }
      };
      ws.onerror = () => {
        if (resources.current === current)
          fail('无法连接录音服务，请确认服务已启动且网络可达。');
      };
      ws.onclose = () => {
        if (resources.current === current)
          fail('录音连接已断开，已保留收到的文字。请重新开始。');
      };
    } catch (cause) {
      if (r && resources.current !== r) {
        releaseAudio(r);
        return;
      }
      const name = cause instanceof DOMException ? cause.name : '';
      fail(
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在浏览器设置中允许此网站使用麦克风。'
          : name === 'NotFoundError'
            ? '未找到可用的麦克风，请连接设备后重试。'
            : '无法启动音频采集，请检查麦克风是否被占用，并使用较新的浏览器。',
      );
    }
  };
  const stop = async () => {
    const r = resources.current;
    if (!r || statusRef.current !== 'recording') return;
    transition('stopping');
    elapsedRef.current = r.offset + (Date.now() - r.started) / 1000;
    setElapsed(elapsedRef.current);
    const flushed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1500);
      r.flush = () => {
        clearTimeout(timer);
        resolve(true);
      };
      r.processor?.port.postMessage({ type: 'flush' });
    });
    if (resources.current !== r) return;
    if (!flushed) {
      fail('浏览器未能提交最后一小段音频，已保存收到的内容，请核对录音末尾。');
      return;
    }
    releaseAudio(r);
    setSpeaking(false);
    setLevel(0);
    if (r.socket?.readyState !== WebSocket.OPEN) {
      fail('录音连接已断开，末尾语音未能提交。');
      return;
    }
    r.socket.send(JSON.stringify({ type: 'end' }));
    r.timeout = setTimeout(() => {
      if (resources.current === r)
        fail('等待最终文字超时，已保留当前识别结果。');
    }, 45_000);
  };
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        segments
          .filter((s) => s.text)
          .map((s) => s.text)
          .join('\n'),
      );
      setCopied(true);
      setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 1800);
    } catch {
      setError('浏览器未允许复制，请手动选择识别文字进行复制。');
    }
  }, [segments]);
  return {
    status,
    segments,
    speaking,
    level,
    elapsed,
    error,
    copied,
    bottomRef,
    start,
    stop,
    copy,
  };
}
