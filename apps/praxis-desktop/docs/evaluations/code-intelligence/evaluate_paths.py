"""Measure semantic entry retrieval separately from compiler-backed path discovery."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import time


def evaluate(snapshot_file,corpus_file,output):
    snapshot=json.loads(snapshot_file.read_text());corpus=json.loads(corpus_file.read_text())
    output.mkdir(parents=True,exist_ok=False)
    process=subprocess.Popen(['dotnet',snapshot['transport'],snapshot['database'],snapshot['models'],snapshot['repositoryId']],
        text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(output/'engine.stderr.log').open('w'),bufsize=1)
    log=(output/'raw-paths.praxis.jsonl').open('w')
    def call(tool,args,case):
        request={'tool':tool,'arguments':{'repositoryId':snapshot['repositoryId'],'responseBudgetTokens':8000,**args}}
        process.stdin.write(json.dumps(request)+'\n');process.stdin.flush()
        response=json.loads(process.stdout.readline())
        log.write(json.dumps({'case':case,'request':request,'response':response})+'\n');log.flush()
        return response
    def trace(id,case):
        return call('trace_flow',{'symbolId':id,'direction':'outgoing','depth':corpus['depth'],
            'maxNodes':corpus['maxNodes'],'maxEdges':corpus['maxEdges'],'edgeKinds':['calls']},case)
    def score(case,traces):
        nodes={node['symbolId'] for t in traces for node in t.get('data',{}).get('nodes',[])}
        edges={(e['sourceSymbolId'],e['targetSymbolId'],e['kind']) for t in traces for e in t.get('data',{}).get('edges',[])}
        required_nodes={n['symbolId'] for n in case['requiredNodes']}
        required_edges={(e['sourceSymbolId'],e['targetSymbolId'],e['kind']) for e in case['requiredEdges']}
        evidence={e['id']:e for t in traces for e in t.get('evidence',[])}
        missing_evidence=[]
        for t in traces:
            for e in t.get('data',{}).get('edges',[]):
                if (e['sourceSymbolId'],e['targetSymbolId'],e['kind']) in required_edges and not any(evidence.get(id,{}).get('path') for id in e.get('evidenceIds',[])):
                    missing_evidence.append(e['edgeId'])
        return {'nodeRecall':len(nodes&required_nodes)/len(required_nodes),
            'edgeRecall':len(edges&required_edges)/len(required_edges),
            'complete':required_nodes<=nodes and required_edges<=edges and not missing_evidence,
            'missingNodes':sorted(required_nodes-nodes),'missingEdges':sorted(required_edges-edges),
            'missingEvidence':missing_evidence,'errors':[t['error'] for t in traces if t.get('error')],
            'truncatedResponses':sum(t.get('truncated',False) for t in traces),
            'reportedBoundaries':[b for t in traces for b in t.get('data',{}).get('boundaries',[])]}
    try:
        before=call('get_index_status',{},'before')
        results=[]
        for case in corpus['cases']:
            oracle=trace(case['entryId'],case['id']+'-oracle')
            search=call('search_code',{'query':case['query'],'mode':'vector','limit':10},case['id']+'-search')
            hits=search.get('data',{}).get('matches',[])
            ids=[h['symbol']['symbolId'] for h in hits]
            seeds=ids[:3]
            traces=[trace(id,case['id']+'-seed') for id in seeds]
            results.append({'id':case['id'],'query':case['query'],'entryRank':next((i+1 for i,id in enumerate(ids) if id==case['entryId']),None),
                'seedIds':seeds,'oracle':score(case,[oracle]),'discovered':score(case,traces),
                'declaredBoundaries':case['boundaries'],'searchError':search.get('error')})
        after=call('get_index_status',{},'after')
        report={'version':1,'measurement':'Static path discovery; not runtime execution or branch feasibility',
            'corpusSha256':hashlib.sha256(corpus_file.read_bytes()).hexdigest(),
            'before':before,'after':after,'stableSnapshot':all(before[k]==after[k] for k in ('indexGeneration','queryEpoch')),
            'seedPolicy':'First three semantic results, without label-guided seed selection',
            'cases':len(results),'entryHitAt10':sum(r['entryRank'] is not None for r in results)/len(results),
            'oracleComplete':sum(r['oracle']['complete'] for r in results),
            'discoveredComplete':sum(r['discovered']['complete'] for r in results),
            'meanDiscoveredEdgeRecall':statistics.mean(r['discovered']['edgeRecall'] for r in results),
            'results':results}
        (output/'paths.praxis.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({k:v for k,v in report.items() if k not in ('before','after','results')},indent=2))
        print('Incomplete oracle cases:',[r['id'] for r in results if not r['oracle']['complete']])
    finally:
        log.close();process.stdin.close();process.wait(timeout=20)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot',type=Path,required=True)
    p.add_argument('--corpus',type=Path,default=Path(__file__).parent/'path-corpus.praxis.json')
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();evaluate(args.snapshot,args.corpus,args.output)
