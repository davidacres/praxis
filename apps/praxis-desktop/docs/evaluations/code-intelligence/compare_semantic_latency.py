"""Sequential, counterbalanced warm query timing on fixed baseline/candidate snapshots."""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import time


def compare(baseline_file,candidate_file,plan_file,output):
    plan=json.loads(plan_file.read_text());output.mkdir(parents=True,exist_ok=False)
    configs=[json.loads(p.read_text()) for p in [baseline_file,candidate_file]]
    processes=[];logs=[];before=[];engines=[];raw=(output/'raw.praxis.jsonl').open('w');rows=[]
    def invoke(arm,tool,args,phase):
        p=processes[arm];s=configs[arm];request={'tool':tool,'arguments':{'repositoryId':s['repositoryId'],'responseBudgetTokens':8000,**args}}
        started=time.perf_counter();p.stdin.write(json.dumps(request)+'\n');p.stdin.flush();line=p.stdout.readline()
        if not line:raise RuntimeError(f'{arm} stopped')
        response=json.loads(line);elapsed=(time.perf_counter()-started)*1000
        raw.write(json.dumps({'arm':arm,'phase':phase,'request':request,'response':response,'latencyMs':elapsed})+'\n');raw.flush()
        return response,elapsed
    try:
        for i,s in enumerate(configs):
            logs.append((output/f'engine-{i}.stderr.log').open('w'))
            processes.append(subprocess.Popen(['dotnet',s['transport'],s['database'],s['models'],s['repositoryId']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=logs[-1],text=True,bufsize=1))
            engines.append(invoke(i,'benchmark_metadata',{},'metadata')[0])
            before.append(invoke(i,'get_index_status',{},'before')[0])
        for arm in [0,1,1,0]:invoke(arm,'search_code',{'query':plan['queries'][0]['query'],'mode':'vector','limit':10},'warmup')
        rng=random.Random(plan['seed'])
        for repetition in range(plan['repetitions']):
            cases=list(plan['queries']);rng.shuffle(cases)
            for case in cases:
                arms=[0,1];rng.shuffle(arms)
                for arm in arms:
                    response,total=invoke(arm,'search_code',{'query':case['query'],'mode':'vector','limit':10},'measurement')
                    matches=list(response.get('data',{}).get('matches',[]));cursor=response.get('nextCursor');pages=1
                    initial=response
                    while len(matches)<10 and cursor and not response.get('error'):
                        response,elapsed=invoke(arm,'search_code',{'query':case['query'],'mode':'vector','limit':10,'cursor':cursor},'paging')
                        total+=elapsed;pages+=1;part=response.get('data',{}).get('matches',[])
                        if not part:break
                        matches.extend(part);cursor=response.get('nextCursor')
                    rows.append({'id':case['id'],'domain':case['domain'],'arm':arm,'repetition':repetition,'latencyMs':total,'pages':pages,'error':response.get('error'),
                                 'generation':initial.get('indexGeneration'),'epoch':initial.get('queryEpoch'),'retrieved':[m['symbol']['symbolId'] for m in matches[:10]],
                                 'fullVectorCoverage':'vector' in initial.get('data',{}).get('channelsUsed',[]) and initial['data']['eligibleSymbolCount']==initial['data']['vectorCoveredSymbolCount']>0})
            print(f'Finished repetition {repetition+1}/{plan["repetitions"]}',flush=True)
        after=[invoke(i,'get_index_status',{},'after')[0] for i in range(2)]
        stats={}
        for arm,label in [(0,'baseline'),(1,'candidate')]:
            times=sorted(r['latencyMs'] for r in rows if r['arm']==arm)
            stats[label]={'calls':len(times),'p50Ms':statistics.median(times),'p95Ms':times[math.ceil(.95*len(times))-1],'meanMs':statistics.mean(times)}
        ranks=defaultdict(list)
        for row in rows:ranks[(row['arm'],row['id'])].append(row['retrieved'])
        checks={'noErrors':all(not r['error'] for r in rows),'fullVectorCoverage':all(r['fullVectorCoverage'] for r in rows),
                'stableRankingsAcrossRepetitions':all(all(v==values[0] for v in values) for values in ranks.values()),
                'stableSnapshots':all(before[i]['indexGeneration']==after[i]['indexGeneration'] and before[i]['queryEpoch']==after[i]['queryEpoch'] and all(r['generation']==before[i]['indexGeneration'] and r['epoch']==before[i]['queryEpoch'] for r in rows if r['arm']==i) for i in range(2))}
        report={'measurement':'Warm sequential first-ten semantic response latency, including required response-budget pages; two idle resident engines, only one active request at a time',
                'engines':engines,'snapshotFiles':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [baseline_file,candidate_file]],
                'planSha256':hashlib.sha256(plan_file.read_bytes()).hexdigest(),'plan':plan,'summary':stats,'checks':checks,'results':rows,
                'limits':'One local machine, warm snapshots, no owner/UI transport, not the release-scale capacity protocol.'}
        (output/'latency.praxis.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'summary':stats,'checks':checks},indent=2))
    finally:
        raw.close()
        for p in processes:p.stdin.close();p.wait(timeout=20)
        for log in logs:log.close()


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['baseline','candidate','plan','output']:p.add_argument('--'+name,required=True,type=Path)
    a=p.parse_args();compare(a.baseline,a.candidate,a.plan,a.output)
