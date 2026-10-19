"""Score the actual vector-mode service on fixed development or fresh acceptance questions."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import time


def evaluate(snapshot_file,dataset,output):
    here=Path(__file__).parent;snapshot=json.loads(snapshot_file.read_text())
    original=json.loads((here/'retrieval-corpus.praxis.json').read_text())
    if dataset=='acceptance':
        corpus_file=here/'semantic-acceptance.praxis.json';corpus=json.loads(corpus_file.read_text())
        cases=[{'id':f['id']+'-'+str(i),'family':f['id'],'query':q,'qualifiedName':f['qualifiedName'],'path':f['path'],
            'sourceSha256':f['sourceSha256'],'group':'fresh'} for f in corpus['families'] for i,q in enumerate(f['queries'])]
    else:
        corpus_file=here/'retrieval-corpus.praxis.json';families={f['id']:f for f in original['families']}
        categories=['exact'] if dataset=='controls' else ['terminology','behaviour']
        cases=[{'id':q['id'],'family':q['familyId'],'query':q['query'],'qualifiedName':q['expected'][0]['qualifiedName'],
            'path':families[q['familyId']]['path'],'sourceSha256':families[q['familyId']]['sourceSha256'],
            'group':'original64' if q['split']=='heldOut' else 'earlierDevelopment'} for q in original['queries'] if q['category'] in categories]
    output.mkdir(parents=True,exist_ok=False)
    process=subprocess.Popen(['dotnet',snapshot['transport'],snapshot['database'],snapshot['models'],snapshot['repositoryId']],
        text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(output/'engine.stderr.log').open('w'),bufsize=1)
    log=(output/'raw-semantic.praxis.jsonl').open('w')
    snapshots=[]
    def call(tool,args):
        request={'tool':tool,'arguments':{'repositoryId':snapshot['repositoryId'],'responseBudgetTokens':8000,**args}}
        started=time.perf_counter();process.stdin.write(json.dumps(request)+'\n');process.stdin.flush()
        line=process.stdout.readline()
        if not line:raise RuntimeError('Service stopped')
        response=json.loads(line)
        log.write(json.dumps({'request':request,'response':response,'latencyMs':(time.perf_counter()-started)*1000})+'\n');log.flush()
        if tool!='benchmark_metadata':snapshots.append((response.get('indexGeneration'),response.get('queryEpoch')))
        return response
    try:
        engine=call('benchmark_metadata',{});before=call('get_index_status',{})
        expected={}
        for case in cases:
            if case['qualifiedName'] in expected:continue
            found=call('find_symbol',{'name':case['qualifiedName'].rsplit('.',1)[-1],'qualifiedName':case['qualifiedName'],'limit':5})
            assert not found.get('error') and len(found['data']['items'])==1,case['id']
            id=found['data']['items'][0]['symbolId'];expected[case['qualifiedName']]=id
            source=call('get_source',{'symbolId':id})
            assert not source.get('error') and all(f['matchesIndexedRevision'] and f['currentHash']=='sha256:'+case['sourceSha256'] for f in source['data']['fragments']),case['id']
        rows=[]
        for n,case in enumerate(cases,1):
            response=call('search_code',{'query':case['query'],'mode':'vector','limit':10})
            matches=list(response.get('data',{}).get('matches',[]))
            cursor=response.get('nextCursor')
            while len(matches)<10 and cursor and not response.get('error'):
                response=call('search_code',{'query':case['query'],'mode':'vector','limit':10,'cursor':cursor})
                page=response.get('data',{}).get('matches',[])
                if not page:break
                matches.extend(page);cursor=response.get('nextCursor')
            ids=[m['symbol']['symbolId'] for m in matches[:10]]
            rank=next((i+1 for i,id in enumerate(ids[:10]) if id==expected[case['qualifiedName']]),None)
            error=response.get('error')
            if error:rank=None
            rows.append({**case,'rank':rank,'hitAt10':rank is not None,'mrrAt10':1/rank if rank else 0,
                'error':error,'duplicateResults':len(ids)!=len(set(ids)),
                'fullSemanticCoverage':'vector' in response.get('data',{}).get('channelsUsed',[]) and response['data']['vectorCoveredSymbolCount']==response['data']['eligibleSymbolCount']>0,
                'retrieved':[m['symbol']['qualifiedName'] for m in matches]})
            if n%16==0:print(f'{dataset}: {n}/{len(cases)}',flush=True)
        after=call('get_index_status',{})
        groups={}
        for group in sorted({r['group'] for r in rows}|{'all'}):
            selected=[r for r in rows if group=='all' or r['group']==group]
            groups[group]={'queries':len(selected),'hitsAt10':sum(r['hitAt10'] for r in selected),
                'hitAt10':statistics.mean(r['hitAt10'] for r in selected),'mrrAt10':statistics.mean(r['mrrAt10'] for r in selected)}
        report={'version':1,'dataset':dataset,'modelAndVectors':'Pinned bge-small; representation format candidate; actual production vector-mode queries',
            'engine':engine,'corpusSha256':hashlib.sha256(corpus_file.read_bytes()).hexdigest(),
            'before':before,'after':after,'summary':groups,
            'checks':{'stableSnapshot':len(set(snapshots))==1,'noErrors':all(not r['error'] for r in rows),
                      'noDuplicates':all(not r['duplicateResults'] for r in rows),'fullSemanticCoverage':all(r['fullSemanticCoverage'] for r in rows)},
            'results':rows,'independentReviewCompleted':False}
        (output/'semantic.praxis.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'summary':groups,'checks':report['checks']},indent=2))
    finally:
        log.close();process.stdin.close();process.wait(timeout=20)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot',type=Path,required=True)
    p.add_argument('--dataset',choices=['development','acceptance','controls'],required=True)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();evaluate(args.snapshot,args.dataset,args.output)
