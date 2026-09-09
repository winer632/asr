import pathlib,json,sys,concurrent.futures,re,unicodedata
from opencc import OpenCC
sys.path.insert(0,'scripts');import importlib
m=importlib.import_module('measure-asr')
root=m.ROOT/'test-output/real-speech'
cases=json.loads((root/'noise-cases.json').read_text())
for source in json.loads((root/'sources.json').read_text()):
 if source['dataset']=='PolyAI/minds14':
  cases.append({'name':'minds_'+source['config'],'path':source['wav'],'source':source,'snr_db':None})
cc=OpenCC('t2s')
def normalize(text,english):
 text=unicodedata.normalize('NFKC',text).casefold()
 if english:return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*",text)
 return [c for c in cc.convert(text) if unicodedata.category(c)[0] in 'LN']
def distance(a,b):
 row=list(range(len(b)+1))
 for i,x in enumerate(a,1):
  current=[i]
  for j,y in enumerate(b,1):current.append(min(current[-1]+1,row[j]+1,row[j-1]+(x!=y)))
  row=current
 return row[-1]
def run(case):
 r=m.http_case('quality_'+case['name'],'/infer',file_name=case['path'])
 try:body=json.loads(r.get('body','{}'))
 except:body={}
 text=body.get('text','')
 pathlib.Path(case['path']).with_suffix('.txt').write_text(text or r.get('body',''))
 pathlib.Path(case['path']).with_suffix('.reference.txt').write_text(case['source']['reference'])
 english=case['source']['config'].startswith('en')
 a,b=normalize(case['source']['reference'],english),normalize(text,english)
 r.update(case=case,transcript=text,language=body.get('language'),metric='WER' if english else 'CER',errors=distance(a,b),reference_units=len(a),error_rate=distance(a,b)/max(1,len(a)))
 print(json.dumps({'name':case['name'],'status':r['status'],'language':r['language'],'text':text,'metric':r['metric'],'error_rate':r['error_rate']},ensure_ascii=False),flush=True)
 return r
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as p:results=list(p.map(run,cases))
(root/'quality-results.json').write_text(m.clean({'normalization':'NFKC; lowercase; Chinese traditional-to-simplified via OpenCC; strip punctuation/spacing; numbers not expanded; English word tokens','results':results}))
print('AUDIO_QUALITY='+str(root),flush=True)
