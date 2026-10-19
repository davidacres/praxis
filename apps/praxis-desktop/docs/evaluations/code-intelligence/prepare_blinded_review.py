"""Build an unscored, rank-blinded packet from the paired acceptance top tens."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import shutil
import subprocess


def prepare(evidence, snapshot_file, output):
    snapshot=json.loads(snapshot_file.read_text())
    runs=[json.loads((evidence/path/'semantic.praxis.json').read_text()) for path in
          ['semantic-baseline-acceptance','semantic-final-reuse-replay']]
    question_rows={}
    for arm,run in enumerate(runs):
        for row in run['results']:
            case=question_rows.setdefault(row['id'],{'query':row['query'],'items':{}})
            assert case['query']==row['query']
            for rank,name in enumerate(row['retrieved'][:10],1):
                case['items'].setdefault(name,[]).append({'arm':arm,'rank':rank})
    symbols={}
    identities={}
    for folder in ['semantic-baseline-acceptance','semantic-final-reuse-replay']:
        for line in (evidence/folder/'raw-semantic.praxis.jsonl').open():
            response=json.loads(line)['response']
            for match in response.get('data',{}).get('matches',[]):
                symbol=match['symbol'];identities[symbol['qualifiedName']]=symbol['symbolId']
    # These are lookup/source reads only: the packet performs no new searches.
    process=subprocess.Popen(['dotnet',snapshot['transport'],snapshot['database'],snapshot['models'],snapshot['repositoryId']],
                             stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
    def call(tool,args):
        process.stdin.write(json.dumps({'tool':tool,'arguments':{'repositoryId':snapshot['repositoryId'],'responseBudgetTokens':8000,**args}})+'\n');process.stdin.flush()
        line=process.stdout.readline()
        if not line:raise RuntimeError('Source transport stopped')
        result=json.loads(line)
        if result.get('error'):raise ValueError(result['error'])
        return result
    try:
        for case in question_rows.values():
            for name in case['items']:
                if name in symbols:continue
                found=call('get_symbol',{'symbolId':identities[name]})['data']
                source=call('get_source',{'symbolId':identities[name]})
                assert source['data']['fragments'] and all(f['matchesIndexedRevision'] and f['currentHash']==f['indexedHash'] for f in source['data']['fragments']),name
                symbols[name]={'declaration':found,'source':source}
    finally:
        process.stdin.close();process.wait(timeout=20)
    output.mkdir(parents=True,exist_ok=False);(output/'questions').mkdir();(output/'sources').mkdir()
    rng=random.Random(20261020);questions=list(question_rows.items());rng.shuffle(questions)
    key={'warning':'Keep hidden until judgments are frozen. Contains rank, arm and original-case mappings.',
         'arms':{'0':'baseline semantic','1':'candidate semantic'},'questions':[]}
    judgments=[];index=['# Blinded semantic relevance review','',
        'Status: **prepared, not reviewed**. No independent human review has been performed.',
        '', 'Judge whether each source result answers the question. Do not open `review-key.praxis.json` or the benchmark score reports before submitting ratings.',
        '', 'Grades: 3 = direct implementation; 2 = independently sufficient answer; 1 = useful context but insufficient; 0 = irrelevant. Leave `grade` null if unjudged. Record a rationale and source citation for every rating. Use `needsMoreContext` when a snippet is insufficient; consult the copied source rather than inferring missing behaviour.',
        '', 'This packet pools the union of the first ten semantic results before and after the change. It hides ranks, engine identity and original anchor labels. It is not a lexical/hybrid top-20 pool and cannot establish exhaustive relevance or agent-answer quality.',
        '', 'Complete `judgments.praxis.jsonl` with reviewer identity and grades, then freeze/hash it before opening the key. A reviewer who authored/tuned this benchmark must declare that conflict; another pass by its author is not independent review.',
        '']
    copied=set()
    for qindex,(original,case) in enumerate(questions,1):
        qid=f'Q{qindex:03}';names=list(case['items']);rng.shuffle(names)
        page=[f'# {qid}', '',case['query'],'','Rate every result independently. Order is randomized.','']
        question_key={'id':qid,'originalId':original,'items':[]}
        for index_in_question,name in enumerate(names,1):
            item_id=f'{qid}-R{index_in_question:02}';source=symbols[name]['source'];dec=symbols[name]['declaration'];path=dec.get('path')
            page += [f'## {item_id}', '', f'`{name}`','']
            for fragment in source['data']['fragments']:
                related=next((e for e in source.get('evidence',[]) if e.get('path') and e.get('fileId')==fragment['fileId']),None)
                if not related:related=next((e for e in source.get('evidence',[]) if e.get('path')),None)
                if related:
                    path=related['path'];relative=Path(path);assert not relative.is_absolute() and '..' not in relative.parts
                    if path not in copied:
                        actual=Path(snapshot['fixtureRoot'])/relative;target=output/'sources'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(actual,target);copied.add(path)
                    page += [f'Source: [{path}](../sources/{path}) · {fragment["currentHash"]}','']
                # Exact native fragment, with no benchmark-derived explanation.
                page += ['````typescript',fragment['text'],'````','']
            judgments.append({'questionId':qid,'resultId':item_id,'reviewer':None,'grade':None,'rationale':None,'citation':None,'needsMoreContext':False})
            question_key['items'].append({'id':item_id,'qualifiedName':name,'origins':case['items'][name]})
        (output/'questions'/f'{qid}.md').write_text('\n'.join(page)+'\n')
        index.append(f'- [{qid}](questions/{qid}.md): {case["query"]}')
        key['questions'].append(question_key)
    (output/'README.md').write_text('\n'.join(index)+'\n')
    (output/'judgments.praxis.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in judgments))
    (output/'review-key.praxis.json').write_text(json.dumps(key,indent=2)+'\n')
    manifest={'status':'awaitingIndependentReviewer','questions':len(questions),'queryResultPairs':len(judgments),'uniqueSymbols':len(symbols),'sourceFiles':len(copied),'allGradesUnjudged':True,
              'sourceManifest':{str(p.relative_to(output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (output/'sources').rglob('*') if p.is_file()}}
    (output/'manifest.praxis.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({k:v for k,v in manifest.items() if k!='sourceManifest'},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence',required=True,type=Path);parser.add_argument('--snapshot',required=True,type=Path);parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args();prepare(args.evidence,args.snapshot,args.output)
