"""Bounded black-box ASR probes. Uses only the API key in the ignored .env.
Run with a Python environment containing websockets (17.x).
Audio and text pairs are written under test-output/boundary-tests/.
"""
import argparse, concurrent.futures, datetime, json, pathlib, threading, time, uuid, wave
import urllib.request, urllib.error, mimetypes
from websockets.sync.client import connect
from websockets.exceptions import InvalidStatus, ConnectionClosed

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENV = dict(line.split("=", 1) for line in (ROOT / ".env").read_text().splitlines() if "=" in line and not line.startswith("#"))
KEY = ENV["ASR_API_KEY"]
BASE = ENV.get("ASR_BASE_URL", "http://10.210.1.23:19003").rstrip("/")
WS = BASE.replace("http://", "ws://").replace("https://", "wss://") + "/infer/stream"
OUT = ROOT / "test-output" / "boundary-tests" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
OUT.mkdir(parents=True, exist_ok=True)
records = []

def clean(value):
    return json.dumps(value, ensure_ascii=False, indent=2).replace(KEY, "[REDACTED]")

def record(result, pcm=None):
    name = result["name"]
    if pcm is not None:
        if len(pcm) % 2 == 0:
            with wave.open(str(OUT / (name + ".wav")), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm)
        else:
            (OUT / (name + ".pcm")).write_bytes(pcm)
        messages = [e["message"] for e in result.get("events", []) if isinstance(e.get("message"), dict)]
        finals = [e for e in messages if e.get("type") == "final"]
        partials = [e for e in messages if e.get("type") == "partial"]
        errors = [e for e in messages if e.get("type") == "error"]
        text = finals[-1].get("text", "") if finals else "【未完成】\n" + (partials[-1].get("text", "") if partials else "")
        if errors: text += "\n" + clean(errors[-1])
        (OUT / (name + ".txt")).write_text(text + "\n")
    (OUT / (name + ".json")).write_text(clean(result))
    summary = {k: result[k] for k in ["name", "status", "seconds", "input_seconds", "first_partial_seconds", "error", "close_code"] if k in result}
    events = [e["message"] for e in result.get("events", []) if isinstance(e.get("message"), dict)]
    last = next((e for e in reversed(events) if e.get("type") in ["final", "error"]), None)
    if last:
        summary["result"] = {k: last[k] for k in ["type", "language", "code", "message", "sequence", "audio_seconds"] if k in last}
        summary["text_excerpt"] = last.get("text", "")[:100]
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return result

def wav_pcm(name):
    with wave.open(str(ROOT / "tests/fixtures" / (name + ".wav")), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        return w.readframes(w.getnframes())

def ws_case(name, pcm=b"", *, extra=None, session_id=None, pace=.02, control="end",
            auth=True, first=None, first_binary=False, idle_before=0, idle_after=0,
            barrier=None, disconnect=False, frame_bytes=3200):
    begin = time.perf_counter()
    result = {"name": name, "input_seconds": len(pcm) / 32000, "pcm_bytes": len(pcm),
              "pace": pace, "events": [], "status": "incomplete"}
    stop = threading.Event(); sender = None
    config = {"type": "start", "session_id": session_id or "probe-" + uuid.uuid4().hex,
              "sample_rate": 16000, "channels": 1, "format": "pcm_s16le"}
    if extra: config.update(extra)
    result["start"] = config
    def event(message):
        result["events"].append({"seconds": round(time.perf_counter() - begin, 4), "message": message})
    try:
        with connect(WS, additional_headers={"Authorization": "Bearer " + KEY} if auth else {},
                     proxy=None, open_timeout=10, close_timeout=2, ping_interval=None, max_size=2_000_000) as ws:
            if idle_before:
                try:
                    message = ws.recv(timeout=idle_before); event(json.loads(message))
                except TimeoutError: result["idle_before_no_timeout_seconds"] = idle_before
                result["status"] = "idle_observed"
            else:
                ws.send(first if first is not None else json.dumps(config))
                first_response = json.loads(ws.recv(timeout=15)); event(first_response)
                if first_response.get("type") != "started":
                    result["status"] = "rejected_start"
                elif idle_after:
                    try:
                        message = ws.recv(timeout=idle_after); event(json.loads(message))
                    except TimeoutError: result["idle_after_no_timeout_seconds"] = idle_after
                    result["status"] = "idle_observed"
                else:
                    def send():
                        try:
                            if barrier: barrier.wait(timeout=15)
                            origin = time.perf_counter()
                            result["audio_send_start"] = round(origin - begin, 4)
                            for offset in range(0, len(pcm), frame_bytes):
                                frame = pcm[offset:offset + frame_bytes]
                                if stop.wait(max(0, origin + (offset + len(frame)) / 32000 * pace - time.perf_counter())): return
                                ws.send(frame)
                            result["audio_send_end"] = round(time.perf_counter() - begin, 4)
                            if disconnect:
                                ws.close(1000, "probe disconnect")
                            elif control is not None:
                                ws.send(json.dumps({"type": control}))
                        except Exception as e:
                            result["sender_error"] = str(e)
                    sender = threading.Thread(target=send, daemon=True); sender.start()
                    deadline = time.perf_counter() + max(75, len(pcm) / 32000 * pace + 35)
                    while time.perf_counter() < deadline:
                        try: raw = ws.recv(timeout=2)
                        except TimeoutError: continue
                        message = json.loads(raw); event(message)
                        if message.get("type") == "partial" and "first_partial_seconds" not in result:
                            result["first_partial_seconds"] = round(time.perf_counter() - begin - result.get("audio_send_start", 0), 4)
                        if message.get("type") in ["final", "error"]:
                            result["status"] = message["type"]
                            if "audio_send_end" in result: result["final_after_send_seconds"] = round(time.perf_counter() - begin - result["audio_send_end"], 4)
                            break
                    else: result["status"] = "client_deadline"
    except InvalidStatus as e:
        result["status"] = "handshake_rejected"; result["http_status"] = e.response.status_code
    except ConnectionClosed as e:
        result["status"] = "client_disconnect" if disconnect else "connection_closed"
        result["close_code"] = e.rcvd.code if e.rcvd else None
        result["error"] = str(e)
    except Exception as e:
        result["status"] = "client_error"; result["error"] = str(e)
    finally:
        stop.set()
        if sender: sender.join(timeout=2)
    result["seconds"] = round(time.perf_counter() - begin, 4)
    return record(result, pcm)

def http_case(name, endpoint, *, fields=None, file_name=None, file_field="audio", auth=True, json_body=None, method="POST"):
    start = time.perf_counter(); headers = {"Authorization": "Bearer " + KEY} if auth else {}
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode(); headers["Content-Type"] = "application/json"
    elif fields is not None or file_name:
        boundary = "probe" + uuid.uuid4().hex; parts = []
        for key, value in (fields or {}).items():
            parts += [("--" + boundary + '\r\nContent-Disposition: form-data; name="' + key + '"\r\n\r\n' + str(value) + "\r\n").encode()]
        if file_name:
            file = pathlib.Path(file_name); content = file.read_bytes()
            mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            parts += [("--" + boundary + '\r\nContent-Disposition: form-data; name="' + file_field + '"; filename="' + file.name + '"\r\nContent-Type: ' + mime + '\r\n\r\n').encode(), content, b"\r\n"]
        parts += [("--" + boundary + "--\r\n").encode()]
        data = b"".join(parts); headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    request = urllib.request.Request(BASE + endpoint, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    result = {"name": name, "endpoint": endpoint, "method": method, "request_bytes": len(data or b"")}
    try:
        with opener.open(request, timeout=30) as r:
            result.update(status=r.status, content_type=r.headers.get("Content-Type"), body=r.read(10000).decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        result.update(status=e.code, content_type=e.headers.get("Content-Type"), body=e.read(10000).decode("utf-8", "replace"))
    except Exception as e: result.update(status="client_error", error=str(e))
    result["seconds"] = round(time.perf_counter() - start, 4)
    return record(result)

def core():
    original = ROOT / "tests/fixtures/mandarin_1.wav"
    requests = [
        ("rest_wav", "/infer", {"file_name": original}),
        ("rest_with_session", "/infer", {"file_name": original, "fields": {"session_id": "probe-" + uuid.uuid4().hex, "language": "Chinese"}}),
        ("rest_no_file", "/infer", {"fields": {}}),
        ("rest_json_empty", "/infer", {"json_body": {}}),
        ("compat_model", "/v1/audio/transcriptions", {"file_name": original, "file_field": "file", "fields": {"model": "sensenova-asr"}}),
        ("compat_sse", "/v1/audio/transcriptions", {"file_name": original, "file_field": "file", "fields": {"stream": "true", "response_format": "text"}}),
        ("infer_get", "/infer", {"method": "GET"}),
    ]
    for name, endpoint, arguments in requests: records.append(http_case(name, endpoint, **arguments))
    invalid = [
        ("start_empty_id", {"session_id": ""}, None), ("start_long_id", {"session_id": "a"*129}, None),
        ("start_unicode_id", {"session_id": "测试"}, None), ("start_unknown_field", {"chunk_seconds": 1}, None),
        ("start_resume_flag", {"resume": True}, None), ("start_wrong_type", {"type": "hello"}, None),
        ("start_null_language", {"language": None}, None), ("start_language_zh", {"language": "zh"}, None),
        ("start_json_null", {}, "null"), ("start_json_array", {}, "[]"), ("start_malformed_json", {}, "{"),
    ]
    for name, extra, first in invalid: records.append(ws_case(name, extra=extra, first=first))
    records.append(ws_case("binary_before_start", first=b"\x00\x00"))
    records.append(ws_case("odd_pcm_byte", pcm=b"\x01"))
    records.append(ws_case("wrong_finish_control", control="finish"))
    records.append(ws_case("empty_audio"))
    records.append(ws_case("silence_5_seconds", pcm=b"\x00" * 160000))
    records.append(ws_case("no_authorization", auth=False))
    print("Starting synchronized 8-client real-time inference.", flush=True)
    names = ["mandarin_1", "cantonese_1", "english_1", "mandarin_2", "cantonese_2", "english_2", "mandarin_1", "english_1"]
    barrier = threading.Barrier(8)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        records.extend(pool.map(lambda pair: ws_case("concurrency8_" + str(pair[0]+1), wav_pcm(pair[1]), pace=1, barrier=barrier), enumerate(names)))
    seed = wav_pcm("mandarin_1")
    def duration_probe(seconds):
        pcm = seed + b"\x00" * max(0, round(seconds*32000) - len(seed))
        return ws_case("duration_" + str(seconds).replace(".", "_"), pcm, pace=1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records.extend(pool.map(duration_probe, [59.9, 60.0, 60.1]))
    records.append(ws_case("fast_send_overload", seed + b"\x00"*(1920000-len(seed)), pace=.02))
    records.append(ws_case("frame_65536", seed[:65536], frame_bytes=65536))
    records.append(ws_case("frame_65538", seed[:65538], frame_bytes=65538))
    replay = "replay-" + uuid.uuid4().hex
    records.append(ws_case("repeat_id_first", wav_pcm("mandarin_2"), session_id=replay))
    records.append(ws_case("repeat_id_second", wav_pcm("english_2"), session_id=replay))
    simultaneous = "duplicate-" + uuid.uuid4().hex
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        records.extend(pool.map(lambda name: ws_case(name, wav_pcm("english_2"), session_id=simultaneous, pace=1), ["duplicate_id_a", "duplicate_id_b"]))
    resume = "resume-" + uuid.uuid4().hex
    records.append(ws_case("disconnect_prefix", wav_pcm("english_1")[:96000], session_id=resume, pace=1, disconnect=True))
    records.append(ws_case("reconnect_same_id", wav_pcm("cantonese_2"), session_id=resume))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(ws_case, "idle_before_start_35s", idle_before=35), pool.submit(ws_case, "idle_after_start_35s", idle_after=35)]
        records.extend(f.result() for f in futures)
    (OUT / "summary.json").write_text(clean({"tested_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "base_url": BASE, "results": records}))
    print("BOUNDARY_RESULTS=" + str(OUT), flush=True)

if __name__ == "__main__":
    core()
