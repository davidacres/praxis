"""Five development iterations over semantic views; fresh acceptance is a separate invocation."""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import statistics
import subprocess
import time

HERE=Path(__file__).parent


def compact(text):
    text=text.strip().rstrip('?')
    text=re.sub(r'^(?:where|how|which|what)\s+(?:(?:is|are|does|do|can|function|helper|code|predicate|method)\s+){0,3}', '',text,flags=re.I)
    text=re.sub(r'\b(?:the app|Praxis)\b','the application',text,flags=re.I)
    return text[0].upper()+text[1:] if text else ''


def views(text):
    short=compact(text)
    clause=[part.strip(' ,.?') for part in re.split(r'\b(?:while|then|before|after|without)\b|[,;]',short,flags=re.I)]
    clause=[part for part in clause if len(part.split())>=4]
    return [text,short,'Source code that implements: '+short]+(clause[:1]+clause[-1:] if len(clause)>1 else [])


def fusion(rankings,weights,k):
    scores=defaultdict(float)
    for ranking,weight in zip(rankings,weights):
        for i,item in enumerate(ranking):scores[item]+=weight/(k+i+1)
    return sorted(scores,key=lambda id:(-scores[id],id))


def diversify(ids,paths,cap):
    if not cap:return ids
    counts=defaultdict(int);first=[];deferred=[]
    for id in ids:
        path=paths.get(id,id)
        if len(first)<10 and counts[path]>=cap:deferred.append(id)
        else:
            first.append(id)
            if len(first)<=10:counts[path]+=1
    return first[:10]+deferred+first[10:]


def metrics(cases,ranked):
    ranks=[next((i+1 for i,id in enumerate(ranked[c['id']][:10]) if id==c['target']),None) for c in cases]
    return {'queries':len(ranks),'hits':sum(r is not None for r in ranks),
            'hitAt10':sum(r is not None for r in ranks)/len(ranks),
            'mrrAt10':statistics.mean(1/r if r else 0 for r in ranks),'ranks':ranks}


class Engine:
    def __init__(self,snapshot,transport,out):
        self.snapshot=snapshot
        self.process=subprocess.Popen(['dotnet',str(transport),snapshot['database'],snapshot['models'],snapshot['repositoryId']],
            text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(out/'engine.stderr.log').open('w'),bufsize=1)
        self.log=(out/'requests.praxis.jsonl').open('w')
        self.cache={}
    def call(self,request):
        self.process.stdin.write(json.dumps(request)+'\n');self.process.stdin.flush()
        line=self.process.stdout.readline()
        if not line:raise RuntimeError('Engine stopped')
        response=json.loads(line)
        self.log.write(json.dumps({'request':request,'response':response})+'\n');self.log.flush()
        return response
    def embedding(self,text):
        if text not in self.cache:
            self.cache[text]=self.call({'tool':'benchmark_vectors','texts':[text]})[0]
        return self.cache[text]
    def candidates(self,vector):
        norm=math.sqrt(sum(x*x for x in vector))
        vector=[x/norm for x in vector]
        return self.call({'tool':'benchmark_candidates','vector':vector,'fingerprint':self.snapshot['fingerprint']})
    def close(self):
        self.process.stdin.close();self.process.wait(timeout=20);self.log.close()


def run(args):
    snapshot=json.loads(args.snapshot.read_text())
    snapshot['fingerprint']='sha256:dc9986ab75caeae2895119a413d6eb31d400ce05e36d6d86225d1e77c801c29c'
    args.output.mkdir(parents=True,exist_ok=False)
    con=sqlite3.connect('file:'+snapshot['database']+'?mode=ro',uri=True)
    paths=dict(con.execute('select s.symbol_id,min(f.relative_path) from symbols s left join locations l on l.symbol_id=s.symbol_id left join files f on f.file_id=l.file_id group by s.symbol_id'))
    roots={r[0] for r in con.execute("select symbol_id from symbols where signature='[synthetic projectRoot]'")}
    if args.acceptance:
        corpus=json.loads((HERE/'semantic-acceptance.praxis.json').read_text())
        cases=[{'id':f['id']+'-'+str(i),'family':f['id'],'query':q,'target':f['symbolId'],'originalSplit':'fresh'}
               for f in corpus['families'] for i,q in enumerate(f['queries'])]
    else:
        corpus=json.loads((HERE/'retrieval-corpus.praxis.json').read_text())
        ids=dict(con.execute('select qualified_name,symbol_id from symbols'))
        cases=[{'id':q['id'],'family':q['familyId'],'query':q['query'],'target':ids[q['expected'][0]['qualifiedName']],'originalSplit':q['split']}
               for q in corpus['queries'] if q['category'] in ('terminology','behaviour')]
    con.close()
    engine=Engine(snapshot,args.transport,args.output)
    try:
        collected={}
        for n,case in enumerate(cases,1):
            texts=views(case['query']);vectors=[engine.embedding(t) for t in texts]
            rankings=[]
            for vector in vectors:
                raw=engine.candidates(vector)
                rankings.append([x['symbolId'] for x in raw if x['symbolId'] not in roots])
            means={}
            for original_weight in (1,2):
                combined=[original_weight*a+b for a,b in zip(vectors[0],vectors[1])]
                raw=engine.candidates(combined)
                means[str(original_weight)]=[x['symbolId'] for x in raw if x['symbolId'] not in roots]
            collected[case['id']]={'texts':texts,'rankings':rankings,'means':means}
            if n%12==0:print(f'Collected semantic views {n}/{len(cases)}',flush=True)
        def ranked(profile):
            output={}
            for case in cases:
                d=collected[case['id']];rs=d['rankings']
                if profile['kind']=='original':ids=rs[0]
                elif profile['kind']=='compact':ids=rs[1]
                elif profile['kind']=='mean':ids=d['means'][str(profile['weight'])]
                else:
                    rs=rs[:profile.get('views',3)]
                    ids=fusion(rs,[profile.get('originalWeight',1)]+[1]*(len(rs)-1),profile['k'])
                output[case['id']]=diversify(ids,paths,profile.get('cap'))
            return output
        if args.acceptance:
            selected=json.loads(args.selected.read_text())['selected']
            profiles=[{'kind':'original'},selected]
            evaluated=[{'profile':p,'all':metrics(cases,ranked(p))} for p in profiles]
            report={'acceptance':True,'corpusSha256':hashlib.sha256((HERE/'semantic-acceptance.praxis.json').read_bytes()).hexdigest(),'cases':cases,'selected':selected,'evaluated':evaluated,'rankings':{str(i):ranked(p) for i,p in enumerate(profiles)}}
        else:
            oldheld=[c for c in cases if c['originalSplit']=='heldOut']
            rounds=[]
            def evaluate(profiles):
                return [{'profile':p,'all':metrics(cases,ranked(p)),'old64':metrics(oldheld,ranked(p))} for p in profiles]
            baseline=evaluate([{'kind':'original'}])[0]
            incumbent={'kind':'original'}
            for number in range(1,6):
                if number==1:profiles=[incumbent,{'kind':'compact'}]
                elif number==2:profiles=[incumbent]+[{'kind':'mean','weight':w} for w in (1,2)]
                elif number==3:profiles=[incumbent]+[{'kind':'fusion','k':k,'views':3} for k in (20,60)]
                elif number==4:profiles=[incumbent]+[{**incumbent,'cap':cap} for cap in (2,3)]
                else:profiles=[incumbent]+[{'kind':'fusion','k':k,'views':5,'cap':cap} for k in (20,60) for cap in (None,2,3)]
                evaluated=evaluate(profiles)
                # Last tie-break conservatively retains the incumbent/control.
                winner=max(range(len(evaluated)),key=lambda i:(evaluated[i]['all']['hitAt10'],evaluated[i]['all']['mrrAt10'],-i))
                incumbent=evaluated[winner]['profile']
                rounds.append({'iteration':number,'candidates':evaluated,'selected':incumbent})
                print('Iteration',number,'selected',json.dumps(incumbent),'score',evaluated[winner]['all']['hitAt10'],'old64',evaluated[winner]['old64']['hitAt10'],flush=True)
            report={'acceptance':False,'baseline':baseline,'iterations':rounds,'selected':incumbent,'cases':cases,'collected':collected,'finalRankings':ranked(incumbent)}
        (args.output/'experiment.praxis.json').write_text(json.dumps(report,indent=2)+'\n')
        print('Saved report',args.output/'experiment.praxis.json')
    finally:engine.close()


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot',type=Path,required=True)
    p.add_argument('--transport',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--acceptance',action='store_true')
    p.add_argument('--selected',type=Path)
    run(p.parse_args())
