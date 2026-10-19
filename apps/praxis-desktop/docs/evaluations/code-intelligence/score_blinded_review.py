"""Validate frozen human ratings before unblinding paired semantic Hit@10."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path


def score(packet, output):
    if output.exists(): raise ValueError('Output already exists')
    ratings_path=packet/'judgments.praxis.jsonl'
    ratings=[json.loads(line) for line in ratings_path.read_text().splitlines() if line.strip()]
    keys=[(row['questionId'],row['resultId']) for row in ratings]
    if len(keys)!=len(set(keys)): raise ValueError('Duplicate ratings')
    for row in ratings:
        if isinstance(row['grade'],bool) or row['grade'] not in [0,1,2,3]: raise ValueError('All results must have integer grades 0–3')
        if not all(isinstance(row.get(field),str) and row[field].strip() for field in ['reviewer','rationale','citation']):
            raise ValueError('Every result needs reviewer identity, rationale and source citation')
        if row.get('needsMoreContext'): raise ValueError('Unresolved context requests remain')
    # Hash and validate ratings BEFORE opening the arm/rank key.
    digest=hashlib.sha256(ratings_path.read_bytes()).hexdigest()
    key=json.loads((packet/'review-key.praxis.json').read_text())
    expected={(q['id'],item['id']) for q in key['questions'] for item in q['items']}
    if set(keys)!=expected: raise ValueError('Ratings do not exactly cover the frozen packet')
    by_id={row['resultId']:row for row in ratings};results=[]
    for question in key['questions']:
        ranks=defaultdict(list)
        for item in question['items']:
            if by_id[item['id']]['grade']>=2:
                for origin in item['origins']: ranks[origin['arm']].append(origin['rank'])
        results.append({'questionId':question['id'],'baselineHitAt10':bool(ranks[0]),'candidateHitAt10':bool(ranks[1])})
    report={'status':'ratingsScored','ratingsSha256':digest,'reviewers':sorted({row['reviewer'] for row in ratings}),
            'independenceVerified':False,'note':'Reviewer identities and conflicts must be checked separately; completion alone does not establish independence.',
            'questions':len(results),'baselineHits':sum(row['baselineHitAt10'] for row in results),
            'candidateHits':sum(row['candidateHitAt10'] for row in results),'results':results}
    output.write_text(json.dumps(report,indent=2)+'\n');return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--packet',required=True,type=Path);parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args();print(json.dumps(score(args.packet,args.output),indent=2))
