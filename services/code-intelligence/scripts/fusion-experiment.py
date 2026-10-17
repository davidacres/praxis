"""Pre-registered fusion experiment: collect every candidate's channel ranks once per query,
then replay rank-based fusion variants offline.

Selection reads only the corpus's tuning cases. Held-out cases (and any extra corpus passed
with --report-only) are scored for every variant and reported, never used to choose. The grid
and the rule below were fixed before any candidates were collected; change them only with a
new, separately recorded experiment.
"""
import argparse
import itertools
import json
import subprocess
import time
from pathlib import Path

# Pre-registered grid. Current production: lexical 16, no floor, no lexical cap.
LEXICAL_WEIGHTS = [4, 8, 16, 32]
VECTOR_FLOORS = [0, 1, 2, 3]      # keep the top-v vector candidates inside the top 10
LEXICAL_CAPS = [None, 20, 10]     # lexical ranks beyond the cap contribute nothing
CURRENT = (16, 0, None)


def collect(executable, data, repository, corpus):
    owner = subprocess.Popen([executable, 'serve', '--data', data], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            if Path(data, 'owner.json').exists():
                break
            time.sleep(.1)

        def invoke(tool, arguments):
            result = subprocess.run([executable, 'query', tool, json.dumps(dict(repositoryId=repository, responseBudgetTokens=8000, **arguments)),
                                     '--data', data], capture_output=True, text=True, timeout=125)
            response = json.loads(result.stdout)
            if result.returncode or response.get('error'):
                raise RuntimeError(json.dumps(response)[:500])
            return response

        # Wait for a settled snapshot: start-up reconciliation may republish once, so require
        # the same generation and epoch, no queued jobs and an active model over several polls.
        snapshot, previous, stable = None, None, 0
        for _ in range(480):
            status = invoke('get_index_status', {})
            jobs = status['data']['jobsByState']
            key = (status['indexGeneration'], status['queryEpoch'])
            settled = not jobs.get('pending') and not jobs.get('leased') and any(m['state'] == 'active' for m in status['data']['models'])
            stable = stable + 1 if settled and key == previous else 0
            previous = key
            if stable >= 30:  # ~15 s: the owner queues one reconcile a few seconds after start
                snapshot = key
                break
            time.sleep(.5)
        if snapshot is None:
            raise TimeoutError('Index did not settle with an active model')
        return collect_settled(invoke, snapshot, corpus)
    finally:
        owner.terminate()
        owner.wait(timeout=10)


def collect_settled(invoke, snapshot, corpus):
    collected = []
    for case in corpus['queries']:
        expected = [invoke('find_symbol', dict(**selector, limit=50))['data']['items'][0]['symbolId'] for selector in case['expected']]
        candidates, cursor, seen = [], None, set()
        while True:
            request = dict(query=case['query'], mode='hybrid', limit=50, **({'cursor': cursor} if cursor else {}))
            response = invoke('search_code', request)
            if (response['indexGeneration'], response['queryEpoch']) != snapshot:
                raise ValueError('Mixed snapshot')
            for match in response['data']['matches']:
                identity = match['symbol']['symbolId']
                if identity in seen:
                    raise ValueError('Duplicate candidate across pages')
                seen.add(identity)
                candidates.append(dict(symbolId=identity, ranks=match['ranks']))
            cursor = response.get('nextCursor')
            if not cursor:
                break
        collected.append(dict(id=case['id'], category=case['category'], split=case['split'], expected=expected, candidates=candidates))
    return collected


def ranked(case, lexical, floor, cap):
    def score(candidate):
        total = 0.0
        for channel, rank in candidate['ranks'].items():
            if channel == 'lexical':
                if cap is None or rank <= cap:
                    total += lexical / (60 + rank)
            else:
                total += (.5 if channel == 'alias' else 1) / (60 + rank)
        return total
    ordered = sorted(case['candidates'], key=lambda c: (-(1 if 'exact' in c['ranks'] else 0), -score(c), c['symbolId']))
    top = ordered[:10]
    if floor:
        by_vector = sorted((c for c in case['candidates'] if 'vector' in c['ranks']), key=lambda c: c['ranks']['vector'])[:floor]
        for candidate in by_vector:
            if candidate in top:
                continue
            # Replace the lowest-placed candidate that is neither exact nor itself a floor pick.
            for index in range(len(top) - 1, -1, -1):
                if 'exact' not in top[index]['ranks'] and top[index] not in by_vector:
                    top[index] = candidate
                    break
            else:
                if len(top) < 10:
                    top.append(candidate)
    return [c['symbolId'] for c in top]


def score_cases(cases, config):
    rows = []
    for case in cases:
        if not case['expected']:
            continue
        ordered = ranked(case, *config)
        expected = set(case['expected'])
        recall = len(expected.intersection(ordered)) / len(expected)
        mrr = next((1 / (i + 1) for i, value in enumerate(ordered) if value in expected), 0)
        rows.append((case['category'], recall, mrr))
    def mean(values):
        values = list(values)
        return sum(values) / len(values) if values else None
    summary = {'all': {'recallAt10': mean(r for _, r, _ in rows), 'mrrAt10': mean(m for _, _, m in rows), 'cases': len(rows)}}
    for category in sorted({c for c, _, _ in rows}):
        summary[category] = {'recallAt10': mean(r for c, r, _ in rows if c == category), 'mrrAt10': mean(m for c, _, m in rows if c == category),
                             'cases': sum(c == category for c, _, _ in rows)}
    return summary


def name(config):
    lexical, floor, cap = config
    return f"lexical{lexical}-floor{floor}-cap{cap or 'none'}"


def distance(config):
    lexical, floor, cap = config
    return (floor, 0 if cap is None else 1, abs(LEXICAL_WEIGHTS.index(lexical) - LEXICAL_WEIGHTS.index(CURRENT[0])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--collected', type=Path, help='Reuse or save collected candidate ranks here')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_bytes())
    if args.collected and args.collected.exists():
        collected = json.loads(args.collected.read_text())
    else:
        collected = collect(args.executable, args.data, args.repository, corpus)
        if args.collected:
            args.collected.write_text(json.dumps(collected) + '\n')
    tuning = [case for case in collected if case['split'] == 'tuning']
    held_out = [case for case in collected if case['split'] == 'heldOut']
    configs = list(itertools.product(LEXICAL_WEIGHTS, VECTOR_FLOORS, LEXICAL_CAPS))
    trials = []
    for config in configs:
        trials.append({'config': name(config), 'tuning': score_cases(tuning, config) if tuning else None,
                       'heldOut': score_cases(held_out, config)})
    selected = CURRENT
    if tuning:
        # Rule: tuning macro Recall@10, then MRR@10, then the configuration closest to production.
        selected = max(configs, key=lambda c: (round(score_cases(tuning, c)['all']['recallAt10'], 9), round(score_cases(tuning, c)['all']['mrrAt10'], 9),
                                                tuple(-d for d in distance(c))))
    report = {'corpus': str(args.corpus), 'grid': {'lexicalWeights': LEXICAL_WEIGHTS, 'vectorFloors': VECTOR_FLOORS, 'lexicalCaps': LEXICAL_CAPS},
              'current': name(CURRENT), 'selectedOnTuning': name(selected) if tuning else None,
              'currentHeldOut': score_cases(held_out, CURRENT), 'selectedHeldOut': score_cases(held_out, selected), 'trials': trials}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'selected': report['selectedOnTuning'], 'current': report['currentHeldOut']['all'], 'selectedHeldOut': report['selectedHeldOut']['all']}))


if __name__ == '__main__':
    main()
