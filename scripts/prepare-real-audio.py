"""Download the exact public rows used for the small audio benchmark and add noise.
Requires ffmpeg and scripts/requirements-asr-tests.txt.
No API key is sent to Hugging Face. Run from the repository root.
"""
from pathlib import Path
import urllib.request,urllib.parse,json,subprocess,wave
import numpy as np

root=Path(__file__).resolve().parents[1]/"test-output/real-speech"
root.mkdir(parents=True,exist_ok=True)
sources=[]
specs=[("google/fleurs",c,"validation") for c in ["cmn_hans_cn","yue_hant_hk","en_us"]]+[("PolyAI/minds14",c,"train") for c in ["en-AU","en-GB","en-US"]]
for dataset,config,split in specs:
    query=urllib.parse.urlencode({"dataset":dataset,"config":config,"split":split,"offset":0,"length":1})
    with urllib.request.urlopen("https://datasets-server.huggingface.co/rows?"+query,timeout=30) as response:
        data=json.load(response)
    entry=data["rows"][0]; row=entry["row"]; audio=row["audio"]
    src=audio[0]["src"] if isinstance(audio,list) else audio["src"]
    with urllib.request.urlopen(src,timeout=30) as response:
        blob=response.read(4_000_001)
    if len(blob)>4_000_000: raise RuntimeError("Unexpectedly large public sample")
    name=config if dataset=="google/fleurs" else "minds_"+config
    original=root/(name+".source"); original.write_bytes(blob)
    wav=root/(name+".wav")
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(original),"-ar","16000","-ac","1","-c:a","pcm_s16le",str(wav)],check=True)
    source={"dataset":dataset,"config":config,"split":split,"row_index":entry.get("row_idx"),"id":row.get("id"),"reference":row.get("raw_transcription") or row["transcription"],"license":"CC-BY-4.0","source":"https://huggingface.co/datasets/"+dataset,"wav":str(wav)}
    sources.append(source)
    wav.with_suffix(".reference.txt").write_text(source["reference"]+"\n")
    print("Downloaded",dataset,config,split,"row",entry.get("row_idx"),flush=True)
(root/"sources.json").write_text(json.dumps(sources,ensure_ascii=False,indent=2))
cases=[]
for index,source in enumerate(sources[:3]):
    with wave.open(source["wav"]) as w: pcm=w.readframes(w.getnframes())
    signal=np.frombuffer(pcm,dtype="<i2").astype(np.float64)/32768
    rms=float(np.sqrt(np.mean(signal**2)))
    for snr in [None,20,10,0]:
        name=source["config"]+("_clean" if snr is None else "_snr"+str(snr))
        gain=1.0
        if snr is None: output=signal
        else:
            noise=np.random.default_rng(20260909+index*100+snr).standard_normal(len(signal))
            noise*=rms/(10**(snr/20)*np.sqrt(np.mean(noise**2)))
            output=signal+noise
            gain=min(1.0,.98/np.max(np.abs(output))); output*=gain
        wav=root/(name+".wav")
        with wave.open(str(wav),"wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes(np.clip(np.round(output*32768),-32768,32767).astype("<i2").tobytes())
        cases.append({"name":name,"path":str(wav),"source":source,"snr_db":snr,"gain":gain,"seconds":len(signal)/16000})
(root/"noise-cases.json").write_text(json.dumps(cases,ensure_ascii=False,indent=2))
