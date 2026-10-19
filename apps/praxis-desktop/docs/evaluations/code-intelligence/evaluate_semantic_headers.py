"""Development-only score study for separate semantic header and source views."""
import json
from pathlib import Path
import statistics
import subprocess
import time

here=Path(__file__).parent
corpus=json.loads((here/'retrieval-corpus.praxis.json').read_text())
labels=json.loads((here/'label-evidence.praxis.json').read_text())
byfamily={label['id']:label['symbolId'] for label in labels['labels']}
out=Path('.praxis/session-artifacts/code-intelligence-benchmark/header-development')
out.mkdir(parents=True,exist_ok=False)
process=subprocess.Popen(['dotnet','/private/tmp/pci-header-20261019/transport/bin/Debug/net10.0/Praxis.CodeIntelligence.Benchmarks.dll',
    '/private/tmp/pci-bench-20261019/data/index.db',
    '/private/tmp/pci-bench-20261019/data/models/dc9986ab75caeae2895119a413d6eb31d400ce05e36d6d86225d1e77c801c29c',
    'query','/private/tmp/pci-header-20261019/headers.bin'],
    text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(out/'engine.stderr.log').open('w'),bufsize=1)
raw=(out/'raw-headers.praxis.jsonl').open('w');rows=[]
try:
    cases=[q for q in corpus['queries'] if q['category'] in ('terminology','behaviour')]
    for n,case in enumerate(cases,1):
        process.stdin.write(json.dumps({'query':case['query']})+'\n');process.stdin.flush()
        result=json.loads(process.stdout.readline())
        raw.write(json.dumps({'id':case['id'],'query':case['query'],'response':result})+'\n');raw.flush()
        ranks={weight:next((i+1 for i,x in enumerate(items[:10]) if x['symbolId']==byfamily[case['familyId']]),None) for weight,items in result.items()}
        rows.append({'id':case['id'],'familyId':case['familyId'],'split':case['split'],'ranks':ranks})
        if n%16==0:print('Header development',n,'/',len(cases),flush=True)
    summary={}
    for weight in rows[0]['ranks']:
        summary[weight]={}
        for group in ['all','original64']:
            selected=[r for r in rows if group=='all' or r['split']=='heldOut']
            ranks=[r['ranks'][weight] for r in selected]
            summary[weight][group]={'queries':len(ranks),'hitsAt10':sum(r is not None for r in ranks),
                'hitAt10':statistics.mean(r is not None for r in ranks),'mrrAt10':statistics.mean(1/r if r else 0 for r in ranks)}
    report={'measurement':'Experimental semantic header/source score combination; production-engine replay required',
        'sourceWeights':'0=original source max; 1=header only; 2=max(header,source); otherwise weighted sum',
        'summary':summary,'results':rows}
    (out/'headers.praxis.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(summary,indent=2))
finally:
    raw.close();process.stdin.close();process.wait(timeout=20)
