from pathlib import Path
import json,re,html
ROOT=Path(__file__).resolve().parents[1]
DOC=ROOT/'docs/index.html'; E=ROOT/'tests/evidence'; page=DOC.read_text()
def esc(x): return html.escape(str(x))
def table(headers,rows):
 return '<div class="table-wrap"><table><thead><tr>'+''.join('<th>'+esc(x)+'</th>' for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+esc(x)+'</td>' for x in row)+'</tr>' for row in rows)+'</tbody></table></div>'
def block(label,text):
 return '<figure><figcaption>'+esc(label)+'<button class="copy" type="button">复制</button></figcaption><pre><code>'+esc(text)+'</code></pre></figure>'
def section(id,title,body):
 global page
 replacement='<section id="'+id+'"><h2>'+title+'</h2>'+body+'</section>'
 page,count=re.subn(r'<section id="'+id+r'">.*?</section>',lambda _:replacement,page,flags=re.S)
 assert count==1,id
core=json.loads((E/'boundary-probes.json').read_text())['results']
http=json.loads((E/'http-capabilities.json').read_text())['results']
quality=json.loads((E/'real-speech-quality-results.json').read_text())['results']
endurance=json.loads((E/'endurance-summary.json').read_text())
latencies=[x['first_partial_seconds'] for x in core if x['name'].startswith('concurrency8_')]
page=page.replace('文件上传接口当前异常','部分容器样本需转换')
page=page.replace('调用方约定；本轮返回 500','最新 WAV 请求实测 200')
page=page.replace('OpenAPI 列出；本轮返回 500','基本转写实测 200；并非完全兼容')
page=page.replace('WebSocket 接口已完成三种语言识别测试。<code>/infer</code> 和 <code>/v1/audio/transcriptions</code> 的文件请求在本轮测试中返回 HTTP 500；健康检查仍返回正常。文件请求上线前需由服务维护方排查并重新验证。','WebSocket、<code>/infer</code> 与 <code>/v1/audio/transcriptions</code> 的基本转写均已成功。早期的文件请求 500 不能代表最新 WAV 状态；部分容器与参数组合仍会报错，详见格式与错误表。')
section('languages','<span>05</span>语种查询与选择',
 '<div class="endpoint"><span class="method">GET</span><code>/languages</code></div><p>需要 Bearer 鉴权，查询不运行识别。</p>'+
 block('实际响应',json.dumps({'languages':['Chinese','English','Cantonese'],'auto_detect':True},ensure_ascii=False,indent=2))+
 table(['语种','响应 language / WS 显式值','HTTP 文件 language'],[['普通话','Chinese','zh'],['粤语','Cantonese','yue'],['英语','English','en']])+
 '<div class="callout"><strong>两个入口的语言参数值不同</strong><p>WS 使用 Chinese / Cantonese / English；HTTP 使用 zh / yue / en。自动检测均建议省略 language。把 Chinese 传给 HTTP，或把 zh 传给 WS，分别触发 400 和 invalid_language。字符串 auto 也被拒绝。</p></div><p>WS 的 language=null 已通过启动校验，但推荐省略。输出可能为繁体或简体字，网页及保存的文本保留服务原文。</p>')
page=page.replace('本项目的客户端实现；上游最大单帧限制未公开','本项目发送粒度；上游单帧为 2–65,536 字节，长度须为偶数')
page=page.replace('为每段生成唯一值','同一时刻不能重用活动 ID；结束后可复用，但新连接从头识别')
page=page.replace('started 声明单会话音频上限 60 秒；连续录音应在接近上限前结束当前会话并创建下一段。','实时验证 60.0 秒成功、60.1 秒返回 audio_limit；连续录音应提前创建下一段。过快灌入音频会触发 overloaded，应按实时速度发送。')
page=page.replace('空音频发送 end 会返回 sequence=0、audio_seconds=0、language=""、text="" 的 final。不能把“收到 final”本身当作存在有效语音的证据。','空音频 end 返回 sequence=0、audio_seconds=0、language=""、text="" 的 final。5 秒全零 PCM 与 10 秒纯高斯噪声也未识别出文字。收到 final 不等于存在有效语音。')
formats=[['WAV','PCM16；另测 8 kHz 单声道、44.1 kHz 双声道、48 kHz 单声道、float32 WAV','200'],['FLAC','FLAC','200'],['MP3','MP3，64 kbit/s','200'],['MPGA','MP2，32 kHz，96 kbit/s','200'],['OGG','Opus，48 kbit/s','200'],['MP4','AAC，64 kbit/s，仅音轨','500'],['M4A','AAC，64 kbit/s','500'],['MPEG','MPEG-PS / MP2','500'],['WebM','Opus 音频','500']]
success=json.loads(next(x['body'] for x in http if x['name']=='format_wav'))
section('upload','<span>08</span>文件上传识别',
 '<div class="endpoint"><span class="method post">POST</span><code>/infer</code></div><p>multipart/form-data，一次上传一个音频文件，由客户端自动生成 boundary。</p>'+
 table(['位置','字段','规则'],[['Header','Authorization','Bearer <API_KEY>'],['Form','audio','文件内容，必填'],['Form','language','可选 zh / en / yue；省略自动检测'],['Form','response_format','建议省略或 json；text 请求成功但仍返回 JSON'],['Form','stream','省略或 false；true 实测返回 502'],['Form','model','不能传；由服务选择模型']])+
 block('curl',"""curl --noproxy '*' -X POST \\
  --connect-timeout 10 --max-time 120 \\
  'http://10.210.1.23:19003/infer' \\
  -H "Authorization: Bearer $ASR_API_KEY" \\
  -F 'audio=@/path/to/audio.wav'""")+
 '<p>audio=@path 从运行 curl 的机器读取文件并上传，不要求服务器访问该路径。示例超时由客户端设置，不是服务端 SLA。</p>'+
 block('最新补测：HTTP 200',json.dumps(success,ensure_ascii=False,indent=2))+
 table(['响应字段','类型','含义'],[['request_id','string','追踪 ID；最新 HTTP 响应同时有 X-Request-ID 头'],['language','string','Chinese / Cantonese / English 等实际返回值'],['text','string','识别文本，可为空']])+
 '<h3>格式与解码实测</h3>'+table(['格式','样本编码','HTTP 状态'],formats)+
 '<p class="small">这是具体编码样本的结果，不穷尽该容器的所有编码组合。失败样本已用正确 MIME 的 curl 复测，仍返回 upstream transcription failed。网页采用原始 PCM；文件接入优先转换成已验证的 WAV。</p>'+
 '<h3>文件时长与体积</h3>'+table(['测试','结果','可以确认的范围'],[['30 / 60 / 61 / 120 秒 WAV','全部 200','至少 120 秒已通过；不同于 WS 的 60 秒限制'],['1 / 4 / 8 / 16 MiB WAV','全部 200','至少 16 MiB 已通过；未触发真实上限']])+
 '<p class="small">时长样本为短语音后补静音；体积样本用 WAV JUNK 块增大文件并保持音频不变。不能由此承诺 120 秒持续说话没有输出截断，也不能把已通过的最大样本当作服务真实上限。</p>'+
 '<p>批量并发建议 8。未知字段及 HTTP session_id 在样本中未报错，但是否实际生效、参与存档或幂等控制没有证据，不应依赖。</p>')
section('compatible','<span>09</span>转写兼容入口',
 '<div class="endpoint"><span class="method post">POST</span><code>/v1/audio/transcriptions</code></div><p>基本转写已成功，文件字段为 file，不能按完整 OpenAI API 兼容实现来假定。</p>'+
 block('基本调用',"""curl --noproxy '*' -X POST \\
  'http://10.210.1.23:19003/v1/audio/transcriptions' \\
  -H "Authorization: Bearer $ASR_API_KEY" \\
  -F 'file=@/path/to/audio.wav'""")+
 table(['参数组合','结果','建议'],[['只传 file','200，JSON request_id/language/text','可用'],['language=zh','200','HTTP 使用短代码'],['model=sensenova-asr','400：model field is not supported','不要传 model'],['stream=true','502：未取得转写结果','SSE 未验证为可用'],['response_format=text（/infer）','200，但仍返回 JSON','不能按纯文本响应解析'],['response_format=verbose_json','400：upstream transcription failed','不要依赖 verbose_json'],['verbose_json + word 时间戳请求','400','未获得词级时间戳']])+
 '<p>默认强制传 model 的 SDK 调用可能失败。客户端应使用本页实际 JSON 契约；流式网页采用已验证的 WebSocket。</p>')
error_rows=[
 ['HTTP 401','无有效 key；/infer 与 /languages 已验证','检查 Bearer 头'],
 ['HTTP 400','错误语言值、model、verbose_json','HTTP 语言用 zh/en/yue，移除不支持字段'],
 ['HTTP 405','GET /infer','改为 POST'],
 ['HTTP 500','部分容器解码失败；缺少文件等异常','检查输入，保留请求 ID'],
 ['HTTP 502','HTTP stream=true','该入口未取得 SSE 转写结果'],
 ['握手 403','无 WS 鉴权；错误路径也可能返回 403','检查路径及凭据'],
 ['invalid_start','ID 为空/过长/中文；未知字段；先发 binary','使用规定的 start'],
 ['invalid_message','JSON null/数组/语法错误；finish','发送 JSON 对象，结束用 end'],
 ['invalid_audio_format','WS 48 kHz、双声道、mp3','WS 固定 PCM16LE / 16 kHz / mono'],
 ['invalid_audio','1 字节 PCM','2–65,536 字节、偶数对齐'],
 ['关闭码 1009','65,538 字节单帧','每帧不超过 65,536 字节'],
 ['invalid_language','WS language=zh/French/auto','完整英文名称或省略'],
 ['session_conflict','重复活动 session_id','活动 ID 必须唯一'],
 ['overloaded','约 50 倍实时速度灌入音频','按实时速度发送，设置有界队列'],
 ['audio_limit','实时 60.1 秒 PCM','提前切换会话'],
 ['timeout','约 10 秒未发送 start；started 后约 30 秒无应用消息','及时发送 start/音频/end'],
 ['断线 / 重试','重连同 ID 从头识别','不假定续传，保留原音频']]
section('errors','<span>10</span>错误、超时与重复会话',
 block('流式错误',json.dumps({'type':'error','code':'audio_limit','message':'session audio duration limit exceeded','request_id':'服务器请求 ID','session_id':'客户端会话 ID'},ensure_ascii=False,indent=2))+
 table(['状态 / 代码','实测触发条件','处理'],error_rows)+
 '<h3>重复 ID 与续传</h3><p>同一活动 ID 的第二个连接被 session_conflict 拒绝。结束后可复用 ID，但返回新的 request_id，sequence/audio_seconds 从新音频计算。关闭 3 秒英语前缀后，同 ID 重连发送粤语只识别了新音频；resume 字段被拒绝。这不能证明存档幂等或避免重复保存。</p>'+
 '<h3>并发与配额</h3><p>同步启动的 8 路实时语音均获得 final，首次文字约 '+str(round(min(latencies),2))+'–'+str(round(max(latencies),2))+' 秒。另有 9 个仅完成 start 的空会话被同时接受；这不是 9 路推理压力测试，也不证明最大推理配额。建议并发仍为 8。</p>'+
 '<p class="small">错误表不是内部所有代码的穷尽清单。HTTP 文件处理的服务器超时尚未触发，测试脚本的客户端超时不能视为服务器超时。静音 PCM 仍是应用消息，不等同于完全不发送消息。</p>')
page=page.replace('每个语音段独立自动检测语种，适合分段切换语言；一句话内部混说多种语言的分类语义未专门验证。','每个 VAD 语音段独立自动检测语种，分段切换三语已通过。句内混语的 HTTP 与 WS 结果出现差异，详见实测章节；响应仅提供一个 language 标签。')
qrows=[]
for config,label,metric in [('cmn_hans_cn','普通话','CER'),('yue_hant_hk','粤语','CER'),('en_us','英语','WER')]:
 values=[]
 for suffix in ['clean','snr20','snr10','snr0']:
  entry=next(x for x in quality if x['case']['name']==config+'_'+suffix); values.append(f"{entry['error_rate']*100:.1f}%")
 qrows.append([label+' / '+metric,*values])
regional=[]
for x in quality:
 if x['case']['source']['dataset']=='PolyAI/minds14':
  config=x['case']['source']['config']; regional.append([config,x['language'],f"{x['error_rate']*100:.1f}%",'参考尾句可能缺失' if config=='en-US' else '除标点外与该条参考一致'])
mixed=json.loads((E/'real-speech-mixed_sentence.json').read_text())
ws_final=[e['message'] for e in mixed['events'] if e.get('message',{}).get('type')=='final'][-1]
controls=json.loads((E/'mixed-sentence-controls.json').read_text())
rest_mixed=json.loads(next(x['body'] for x in controls if x['name']=='control_mixed_sentence'))
rss=[x['rssMiB'] for x in endurance['memory'] if x['rssMiB'] is not None]
body='<p>补测日期：2026-09-09。音频、对应文本、原始响应在项目 test-output/，精简证据在 tests/evidence/。下列是小样本功能验证，不是总体准确率报告。</p>'
body+='<h3>协议与稳定性</h3>'+table(['项目','实测结果','范围'],[
 ['8 路实时识别','8/8 final；首次文字约 2.09–2.23 秒','同步发起的短语音'],
 ['WS 时长','59.9 / 60.0 秒成功；60.1 秒 audio_limit','按实时速度发送'],
 ['WS 单帧','65,536 字节成功；65,538 触发 1009','PCM16 偶数对齐'],
 ['10 分钟网页链路','73 段均有 final，无接口 error 或断线','合成三语，经原 VAD 与真实 ASR'],
 ['完整录音','保存 PCM 与输入 SHA-256 一致','600 秒，19,200,000 字节 PCM'],
 ['本地桥接 RSS',f'{min(rss):.1f}–{max(rss):.1f} MiB，结束 {rss[-1]:.1f} MiB','每分钟采样，不是远端模型资源'],
 ['浏览器布局','320 / 390 / 430 / 768 / 1280 px 无页面横向溢出','桌面 Chrome 尺寸模拟，非真机']])
body+='<h3>真人语音与人工噪声</h3><p>采用 <a href="https://huggingface.co/datasets/google/fleurs">Google FLEURS</a> 的 cmn_hans_cn、yue_hant_hk、en_us 各 1 条真人录音，分别生成整段 RMS 定义的 20、10、0 dB 高斯噪声版本，共 12 条，语种标签均正确。人工噪声不能代表真实街道、会议室或多人串音。</p>'
body+=table(['样本 / 指标','原音','20 dB','10 dB','0 dB'],qrows)
body+='<p class="small">CER/WER：NFKC、英文小写；中文繁转简并去标点/空白；英文按词比较；不展开数字或缩写。粤语 5.3% 来自 40/四十，英语 13.3% 来自 you are/you’re 形式差异。普通话 0 dB 的“宗派→宗教”“或→和”是实质错词。原始误差不能直接当作语义准确率。</p>'
body+='<h3>地区英语样本</h3><p><a href="https://huggingface.co/datasets/PolyAI/minds14">PolyAI MInDS-14</a> 的 en-AU、en-GB、en-US 分组各取第 1 条真人录音。分组来自数据集，不推断说话人的身份或国籍。</p>'+table(['分组','返回语种','按原标注 WER','说明'],regional)
body+='<p class="small">美式分组输出比原标注多出尾问句。<a href="https://huggingface.co/docs/transformers/v4.46.0/quicktour">Hugging Face 官方示例</a>中的另一识别器也输出该尾句，据此认为标注可能不完整，不使用原始 58.3% WER 排序口音效果。两套数据均为 CC BY 4.0，配置、split、行号保留在证据中。</p>'
body+='<h3>句内混语对照</h3><p>三段合成短语紧邻拼接成 3.92 秒音频，均省略 language，分别调用 HTTP 与 WS。</p>'
body+=block('参考短句','请帮我确认 the meeting starts at three 唔好遲到呀。')
body+=block('HTTP 文件结果 · language='+rest_mixed['language'],rest_mixed['text'])
body+=block('WS 最终结果 · language='+ws_final['language'],ws_final['text'])
body+='<p>此样本的 WS 漏掉开头普通话，HTTP 保留三语内容。句内混语仍可能丢词；“支持三种语言”不能推导为所有流式混语可靠。VAD 停顿分段后连续切换三语已通过。</p>'
body+='<h3>VAD 噪声边界</h3><p>真人及噪声版本均检测到语音，但片段数随噪声变化；纯高斯噪声也误触发 1 段。ASR 对纯噪声返回空文字，网页会标记未识别出文字并保留音频。不能承诺所有背景噪声下零误触。</p>'
body+='<h3>仍不能仅凭外部调用确认</h3><ul><li>真实最大上传体积、文件时长和 HTTP 服务端超时：已通过 16 MiB / 120 秒，但未触发真实上限。</li><li>远端存档、保存目录、保留周期、删除机制及存档幂等：需要源码、部署配置或日志。</li><li>全局推理配额、远端资源曲线及数小时/数天稳定性。</li><li>真实 iPhone/Android 型号的麦克风、后台/锁屏、网络切换，以及真实复杂环境噪声：尚无真机验证。</li><li>未公开参数与内部错误码的穷尽清单：本页只将有证据的行为作为可依赖契约。</li></ul>'
body+='<p class="source-list">依据：调用方协议、<a href="http://10.210.1.23:19003/openapi.json">服务 OpenAPI</a>、tests/evidence/ 实测记录。服务升级后应重新核验。</p>'
section('verification','<span>14</span>边界、真人样本与稳定性实测',body)
page=page.replace('14 实测记录与边界','14 边界与稳定性实测')
DOC.write_text(page)
print('Updated responsive API reference from measured evidence.')
