"""Paired retrieval measurement using an immutable backup and production QueryService."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import time

MODES = ('lexical', 'vector', 'hybrid')
SEED = 20261019


def score(expected, retrieved):
    slots = retrieved[:10]
    identities = set(expected)
    if not identities:
        return None
    rank = next((i + 1 for i, item in enumerate(slots) if item in identities), None)
    return {'hitAt1': float(rank == 1), 'hitAt3': float(rank is not None and rank <= 3),
            'hitAt5': float(rank is not None and rank <= 5), 'hitAt10': float(rank is not None),
            'recallAt10': len(identities.intersection(slots)) / len(identities),
            'mrrAt10': 1 / rank if rank else 0, 'firstRelevantRank': rank}


def paired_interval(records, metric, candidate, baseline='lexical'):
    families = defaultdict(dict)
    for row in records:
        families[row['familyId']].setdefault(row['mode'], []).append(row['metrics'][metric])
    deltas = [statistics.mean(group[candidate]) - statistics.mean(group[baseline])
              for group in families.values()]
    rng = random.Random(SEED)
    draws = sorted(statistics.mean(rng.choices(deltas, k=len(deltas))) for _ in range(10000))
    return {'candidate': candidate, 'baseline': baseline, 'metric': metric,
            'families': len(deltas), 'difference': statistics.mean(deltas),
            'lower95': draws[249], 'upper95': draws[9749], 'bootstrapResamples': 10000, 'seed': SEED}


def summarize(rows):
    held = [r for r in rows if r['split'] == 'heldOut' and r['metrics'] is not None]
    summaries = {}
    for category, selected in [('naturalLanguage', [r for r in held if r['category'] != 'exact']),
                               ('exact', [r for r in held if r['category'] == 'exact']),
                               ('allPositive', held)]:
        summaries[category] = {}
        for mode in MODES:
            cases = [r for r in selected if r['mode'] == mode]
            summaries[category][mode] = {'queries': len(cases), 'hitsAt10': sum(r['metrics']['hitAt10'] for r in cases),
                **{metric: statistics.mean(r['metrics'][metric] for r in cases)
                   for metric in ('hitAt1','hitAt3','hitAt5','hitAt10','recallAt10','mrrAt10')}}
    natural = [r for r in held if r['category'] != 'exact']
    intervals = [paired_interval(natural, metric, mode) for mode in ('vector','hybrid')
                 for metric in ('hitAt10','mrrAt10')]
    domains = {}
    for domain in sorted({r['domain'] for r in natural}):
        domains[domain] = {mode: {'queries': len(cases),
            'hitAt10': statistics.mean(r['metrics']['hitAt10'] for r in cases),
            'mrrAt10': statistics.mean(r['metrics']['mrrAt10'] for r in cases)}
            for mode in MODES if (cases := [r for r in natural if r['domain'] == domain and r['mode'] == mode])}
    latency = {}
    for mode in MODES:
        times = sorted(r['latencyMs'] for r in rows if r['mode'] == mode)
        latency[mode] = {'p50Ms': statistics.median(times), 'p95Ms': times[math.ceil(.95*len(times))-1]}
    return {'heldOut': summaries, 'pairedNaturalLanguageIntervals': intervals,
            'heldOutNaturalLanguageDomains': domains, 'warmEngineLatency': latency}


def run(snapshot_path, corpus_path, output):
    snapshot = json.loads(snapshot_path.read_text())
    corpus = json.loads(corpus_path.read_text())
    output.mkdir(parents=True, exist_ok=False)
    process = subprocess.Popen(['dotnet', snapshot['transport'], snapshot['database'], snapshot['models'], snapshot['repositoryId']],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(output/'transport.stderr.log').open('w'), text=True, bufsize=1)
    raw = (output/'raw-responses.praxis.jsonl').open('w')
    def invoke(tool, arguments, **metadata):
        request = {'tool': tool, 'arguments': {'repositoryId': snapshot['repositoryId'], 'responseBudgetTokens': 8000, **arguments}}
        started = time.perf_counter()
        process.stdin.write(json.dumps(request)+'\n'); process.stdin.flush()
        line = process.stdout.readline()
        if not line:
            raise RuntimeError('Transport stopped; inspect transport.stderr.log')
        response = json.loads(line)
        elapsed = (time.perf_counter()-started)*1000
        raw.write(json.dumps({'request':request,'response':response,'latencyMs':elapsed,**metadata})+'\n'); raw.flush()
        return response, elapsed
    try:
        metadata, _ = invoke('benchmark_metadata', {}, phase='metadata')
        before, _ = invoke('get_index_status', {}, phase='before')
        assert before['indexGeneration'] == snapshot['indexGeneration'] and before['queryEpoch'] == snapshot['queryEpoch']
        active = [m for m in before['data']['models'] if m['state']=='active']
        assert len(active)==1 and active[0]['coverage']['current']==active[0]['coverage']['eligible']>0
        expected = {}
        for family in corpus['families']:
            response, _ = invoke('find_symbol', {**family['selector'],'limit':50}, phase='resolve', familyId=family['id'])
            assert not response.get('error') and len(response['data']['items'])==1, family['id']
            item=response['data']['items'][0]
            assert item['resolution']=='resolved', family['id']
            source, _ = invoke('get_source', {'symbolId':item['symbolId']}, phase='source-check',familyId=family['id'])
            assert not source.get('error') and source['data']['fragments'], family['id']
            assert all(f['matchesIndexedRevision'] and f['currentHash']=='sha256:'+family['sourceSha256']
                       for f in source['data']['fragments']), family['id']
            expected[family['id']]=item['symbolId']
        for mode in MODES:
            invoke('search_code', {'query':'repository navigation','mode':mode,'limit':20}, phase='warmup',mode=mode)
        rng=random.Random(SEED)
        cases=list(corpus['queries']); rng.shuffle(cases)
        rows=[]
        for ordinal, case in enumerate(cases, 1):
            order=list(MODES); rng.shuffle(order)
            for mode in order:
                # Collect top 20 for later relevance pooling; metrics always use
                # the first ten original slots, never backfill misses or duplicates.
                matches=[]; envelopes=[]; elapsed=0; arguments={'query':case['query'],'mode':mode,'limit':20}
                while len(matches)<20:
                    response, latency=invoke('search_code', arguments, phase='measurement',caseId=case['id'],mode=mode)
                    elapsed+=latency; envelopes.append(response)
                    matches.extend(response.get('data',{}).get('matches',[]))
                    cursor=response.get('nextCursor')
                    if response.get('error') or not cursor or not response.get('data',{}).get('matches'): break
                    arguments={**arguments,'cursor':cursor}
                matches=matches[:20]
                ids=[m['symbol']['symbolId'] for m in matches]
                is_negative=case['category']=='negative'
                metrics=None if is_negative else score([expected[case['familyId']]],ids)
                errors=[r['error'] for r in envelopes if r.get('error')]
                # A query error must count as a miss, even if another page had a hit.
                if errors and not is_negative: metrics=score([expected[case['familyId']]],[])
                evidence={e['id']:e for r in envelopes for e in r.get('evidence',[])}
                relevant=[m for m in matches[:10] if m['symbol']['symbolId']==expected[case['familyId']]]
                missing_evidence=any(not any(evidence.get(id,{}).get('path') in case['expectedEvidence']
                                      for id in m.get('evidenceIds',[])) for m in relevant) if not is_negative else False
                rows.append({k:case[k] for k in ('id','familyId','domain','category','split')} | {
                    'mode':mode,'modeOrder':order,'ordinal':ordinal,'metrics':metrics,'latencyMs':elapsed,'errors':errors,
                    'counterEvidenceHitAt10': bool(expected[case['familyId']] in ids[:10]) if is_negative else None,
                    'duplicates':len(ids)!=len(set(ids)), 'missingPrimaryEvidence':missing_evidence,
                    'snapshotStable':all(r.get('indexGeneration')==snapshot['indexGeneration'] and r.get('queryEpoch')==snapshot['queryEpoch'] for r in envelopes),
                    'vectorAvailable':all('vector' in r.get('data',{}).get('channelsUsed',[]) and r['data']['vectorCoveredSymbolCount']==r['data']['eligibleSymbolCount']>0 for r in envelopes) if mode!='lexical' else None,
                    'retrieved': [{'symbolId':m['symbol']['symbolId'],'qualifiedName':m['symbol']['qualifiedName'],
                                  'resolution':m['symbol']['resolution'],'paths':sorted({evidence[id]['path'] for id in m['evidenceIds'] if evidence.get(id,{}).get('path')})} for m in matches]})
            if ordinal%12==0: print(f'Completed {ordinal}/{len(cases)} queries ({ordinal*3} mode comparisons)',flush=True)
        after,_=invoke('get_index_status',{},phase='after')
        report={'version':1,'measurement':'Primary-anchor retrieval only; not independently pooled relevance or agent answer quality',
            'seed':SEED,'corpusSha256':hashlib.sha256(corpus_path.read_bytes()).hexdigest(),
            'snapshot':snapshot,'engine':metadata,'before':before,'after':after,
            'negativeCases':'Counter-evidence retrieval retained for diagnosis; no abstention or answer-quality success claimed',
            'checks':{'noToolErrors':all(not r['errors'] for r in rows),'noDuplicateResults':all(not r['duplicates'] for r in rows),
                'primaryEvidencePresent':all(not r['missingPrimaryEvidence'] for r in rows),
                'stableSnapshot':all(r['snapshotStable'] for r in rows) and before['indexGeneration']==after['indexGeneration'] and before['queryEpoch']==after['queryEpoch'],
                'fullSemanticCoverage':all(r['vectorAvailable'] for r in rows if r['mode']!='lexical'),
                'databaseUnchanged':hashlib.file_digest(Path(snapshot['database']).open('rb'),'sha256').hexdigest()==snapshot['databaseSha256']},
            **summarize(rows),'results':rows,'releaseAcceptanceClaimed':False,'independentReviewCompleted':False}
        (output/'results.praxis.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({k:report[k] for k in ('checks','heldOut','pairedNaturalLanguageIntervals')},indent=2))
        return report
    finally:
        raw.close(); process.stdin.close()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired: process.kill(); process.wait()


def self_check():
    assert score(['target'],['noise']*10+['target'])['hitAt10']==0
    assert score(['target'],['noise']*9+['target'])['mrrAt10']==.1
    assert score(['a','b'],['a','a'])['recallAt10']==.5
    assert score([],[]) is None
    assert score(['a'],[])['mrrAt10']==0
    assert score(['a'],['a'])['hitAt1']==1
    rows=[{'familyId':family,'mode':mode,'metrics':{'hitAt10':value}}
          for family in ['one','two'] for mode,value in [('lexical',0),('hybrid',1)]]
    interval=paired_interval(rows,'hitAt10','hybrid')
    assert interval['difference']==interval['lower95']==interval['upper95']==1
    print('Metric self-checks passed: slot limits, duplicate recall, empty labels, misses and clustered intervals.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path)
    parser.add_argument('--corpus',type=Path,default=Path(__file__).parent/'retrieval-corpus.praxis.json')
    parser.add_argument('--output',type=Path)
    parser.add_argument('--self-check',action='store_true')
    args=parser.parse_args()
    if args.self_check: self_check()
    else:
        if not args.snapshot or not args.output: parser.error('--snapshot and --output are required')
        run(args.snapshot,args.corpus,args.output)
