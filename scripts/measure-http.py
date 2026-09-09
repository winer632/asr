import sys, pathlib, json, subprocess, wave, struct
sys.path.insert(0, 'scripts')
import importlib
m=importlib.import_module('measure-asr')
root=m.ROOT; out=m.OUT; results=[]
source=root/'tests/fixtures/mandarin_1.wav'
formats={'wav':[], 'flac':['-c:a','flac'], 'mp3':['-c:a','libmp3lame','-b:a','64k'], 'mp4':['-c:a','aac','-b:a','64k'], 'mpeg':['-c:a','mp2','-ar','32000','-b:a','96k','-f','mpeg'], 'mpga':['-c:a','mp2','-ar','32000','-b:a','96k','-f','mp2'], 'm4a':['-c:a','aac','-b:a','64k'], 'ogg':['-c:a','libopus','-b:a','48k'], 'webm':['-c:a','libopus','-b:a','48k']}
for extension,codec in formats.items():
 file=out/('format_'+extension+'.'+extension)
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),*codec,str(file)],check=True,capture_output=True)
 result=m.http_case('format_'+extension,'/infer',file_name=file);results.append(result)
 try: text=json.loads(result.get('body','{}')).get('text','')
 except: text=''
 file.with_suffix('.txt').write_text(text or result.get('body',''))
cases=[('language_zh','/infer',{'language':'zh'},'mandarin_1'),('language_yue','/infer',{'language':'yue'},'cantonese_1'),('language_en','/infer',{'language':'en'},'english_1'),('language_auto','/infer',{'language':'auto'},'mandarin_1'),('session_id_rest','/infer',{'session_id':'probe-rest-explicit'},'mandarin_1'),('unknown_field','/infer',{'unknown_probe':'1'},'mandarin_1'),('response_json','/infer',{'response_format':'json'},'mandarin_1'),('response_text','/infer',{'response_format':'text'},'mandarin_1'),('response_verbose','/infer',{'response_format':'verbose_json'},'mandarin_1'),('stream_true','/infer',{'stream':'true'},'mandarin_1'),('stream_false','/infer',{'stream':'false'},'mandarin_1'),('compat_basic','/v1/audio/transcriptions',{},'mandarin_1'),('compat_language_zh','/v1/audio/transcriptions',{'language':'zh'},'mandarin_1'),('compat_verbose_timestamps','/v1/audio/transcriptions',{'response_format':'verbose_json','timestamp_granularities[]':'word'},'mandarin_1')]
for name,endpoint,fields,sample in cases:
 results.append(m.http_case(name,endpoint,fields=fields,file_name=root/('tests/fixtures/'+sample+'.wav'),file_field='file' if endpoint.startswith('/v1/') else 'audio'))
results.append(m.http_case('rest_no_auth','/infer',file_name=source,auth=False))
pcm=m.wav_pcm('mandarin_1')
for seconds in [30,60,61,120]:
 file=out/('file_duration_'+str(seconds)+'.wav')
 with wave.open(str(file),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(pcm+b'\0'*(seconds*32000-len(pcm)))
 result=m.http_case('file_duration_'+str(seconds),'/infer',file_name=file);results.append(result);file.with_suffix('.txt').write_text(result.get('body',''))
 if result.get('status') not in [200]:break
for mb in [1,4,8,16]:
 total=mb*1024*1024; padding=total-52-len(pcm)
 blob=b'RIFF'+struct.pack('<I',total-8)+b'WAVE'+b'fmt '+struct.pack('<IHHIIHH',16,1,1,16000,32000,2,16)+b'JUNK'+struct.pack('<I',padding)+b'\0'*padding+b'data'+struct.pack('<I',len(pcm))+pcm
 file=out/('file_size_'+str(mb)+'MiB.wav');file.write_bytes(blob)
 with wave.open(str(file)) as w:assert w.readframes(w.getnframes())==pcm
 result=m.http_case('file_size_'+str(mb)+'MiB','/infer',file_name=file);results.append(result);file.with_suffix('.txt').write_text(result.get('body',''))
 if result.get('status') not in [200]:break
(out/'http-summary.json').write_text(m.clean({'results':results}))
print('HTTP_CAPABILITIES='+str(out),flush=True)
