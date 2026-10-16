import json,subprocess,time,signal,hashlib,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description='Select fusion weights using only frozen tuning cases and complete channel ranks.')
for option in ['executable','data','baseline','corpus','output']:parser.add_argument('--'+option,required=True,type=Path)
args=parser.parse_args()
if not str(args.output).endswith('.praxis.json'):parser.error('Output must end in .praxis.json')
exe=str(args.executable.resolve());data=str(args.data.resolve())
report=json.loads(args.baseline.read_text());repository=report['fixtureRepositoryId']
corpus=json.loads(args.corpus.read_text());cases=[case for case in corpus['queries'] if case['split']=='tuning'];assert len(cases)==40
owner=subprocess.Popen([exe,'serve','--data',data],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 for _ in range(150):
  if Path(data+'/owner.json').exists():break
  if owner.poll() is not None:raise RuntimeError('Owner exited')
  time.sleep(.1)
 def invoke(tool,args):
  r=subprocess.run([exe,'query',tool,json.dumps(dict(repositoryId=repository,responseBudgetTokens=8000,**args)),'--data',data],capture_output=True,text=True,timeout=125)
  d=json.loads(r.stdout)
  if r.returncode or d.get('error'):raise RuntimeError(str(d))
  return d
 time.sleep(2)
 previous=None;stable=0
 for _ in range(120):
  snapshot=invoke('get_index_status',{});jobs=snapshot.get('data',{}).get('jobsByState',{})
  key=(snapshot['indexGeneration'],snapshot['queryEpoch'])
  stable=stable+1 if key==previous and not jobs.get('pending') and not jobs.get('leased') else 0
  previous=key
  if stable>=4:break
  time.sleep(.25)
 else:raise ValueError('Owner startup reconciliation did not settle')
 collected=[]
 for case in cases:
  expected=[invoke('find_symbol',dict(**selector,limit=50))['data']['items'][0]['symbolId'] for selector in case['expected']]
  matches=[];cursor=None;seen=set()
  while True:
   args=dict(query=case['query'],mode='hybrid',limit=50)
   if cursor:
    args['cursor']=cursor
   r=invoke('search_code',args)
   if (r['indexGeneration'],r['queryEpoch'])!=(snapshot['indexGeneration'],snapshot['queryEpoch']):raise ValueError('Mixed snapshot')
   for m in r['data']['matches']:
    identity=m['symbol']['symbolId']
    if identity in seen:raise ValueError('Duplicate candidate across pages')
    seen.add(identity);matches.append(dict(symbolId=identity,ranks=m['ranks']))
   cursor=r.get('nextCursor')
   if not cursor:break
  collected.append(dict(id=case['id'],category=case['category'],expected=expected,candidates=matches))
  print('Collected tuning',case['id'],len(matches),flush=True)
 trials=[]
 for lexical in [1,1.25,1.5,2,3,4]:
  values=[];rr=[];per={}
  for case in collected:
   if not case['expected']:continue
   def key(m):
    ranks=m['ranks'];score=sum((lexical if channel=='lexical' else 1)/(60+rank) for channel,rank in ranks.items())
    return (-(1 if 'exact' in ranks else 0),-score,m['symbolId'])
   ordered=[m['symbolId'] for m in sorted(case['candidates'],key=key)[:10]]
   recall=len(set(ordered)&set(case['expected']))/len(case['expected'])
   mrr=next((1/(i+1) for i,v in enumerate(ordered) if v in case['expected']),0)
   values.append(recall);rr.append(mrr);per[case['id']]=recall
  trials.append(dict(lexicalWeight=lexical,vectorWeight=1,aliasWeight=1,macroRecallAt10=sum(values)/len(values),mrrAt10=sum(rr)/len(rr),perCaseRecall=per))
 best=max(trials,key=lambda t:(t['macroRecallAt10'],t['mrrAt10'],-t['lexicalWeight']))
 output=dict(selectionBasis='Only the 40 frozen tuning cases; maximum macro recall, then MRR, then lower lexical weight. No held-out cases loaded for selection.',corpusHash='sha256:'+hashlib.sha256(args.corpus.read_bytes()).hexdigest(),indexGeneration=snapshot['indexGeneration'],queryEpoch=snapshot['queryEpoch'],selected=best,trials=trials,cases=collected)
 args.output.write_text(json.dumps(output,indent=2)+'\n');print('SELECTED',best,flush=True)
finally:
 if owner.poll() is None:
  owner.send_signal(signal.SIGINT)
  try:owner.wait(timeout=5)
  except subprocess.TimeoutExpired:owner.kill();owner.wait(timeout=5)
