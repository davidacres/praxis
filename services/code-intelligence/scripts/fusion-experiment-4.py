"""Pre-registered fusion experiment 4: hybrid after the semantic-header representation.

Hypothesis: with format-5 vectors, semantic-only search beats hybrid on natural-language
TypeScript/JavaScript questions because (a) hybrid's vector channel embeds the question once,
while semantic-only also fuses SemanticQueryViews rephrasings, and (b) lexical weight 4 was
selected (plan 8) when the vector channel was weaker. Two arms are collected: the production
engine (single view) and an engine identical except that hybrid also uses the query views.

Disclosure: the hypothesis was formed after seeing hybrid trail semantic-only on the TypeScript
pilot, the desktop held-out split and markdown-it (2026-10-20 floor-2 replays). Those sets are
therefore not blind checks; the Maze held-out split is the guard against a C# regression, and
selection reads only the TypeScript tuning corpus, as in experiments 2 and 3.

Collection uses the frozen-snapshot transport (one process per arm and snapshot, read-only
database) instead of a live owner, and pages every hybrid candidate with its channel ranks, as
in experiment 1. Replay reuses experiment 1's ranked() and score_cases(). The grid and rule are
fixed before any candidates are collected; change them only with a new, recorded experiment.
"""
import argparse
import importlib.util
import json
import subprocess
from pathlib import Path

_spec = importlib.util.spec_from_file_location('fusion1', Path(__file__).with_name('fusion-experiment.py'))
fusion1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fusion1)

# Pre-registered grid. Current production: single view, lexical 4, floor 2, no cap.
ARMS = ['single', 'views']
LEXICAL_WEIGHTS = [1, 2, 4]
FLOOR = 2
CURRENT = ('single', 4)


def collect(snapshot_path, corpus):
    snapshot = json.loads(Path(snapshot_path).read_text())
    process = subprocess.Popen(['dotnet', snapshot['transport'], snapshot['database'], snapshot['models']],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)

    def invoke(tool, arguments):
        request = {'tool': tool, 'arguments': {'repositoryId': snapshot['repositoryId'], 'responseBudgetTokens': 8000, **arguments}}
        process.stdin.write(json.dumps(request) + '\n')
        process.stdin.flush()
        line = process.stdout.readline()
        if not line:
            raise RuntimeError('Transport stopped')
        response = json.loads(line)
        if response.get('error'):
            raise RuntimeError(json.dumps(response)[:500])
        return response

    try:
        status = invoke('get_index_status', {})
        key = (status['indexGeneration'], status['queryEpoch'])
        collected, unresolved = [], []
        for case in corpus['queries']:
            expected = []
            for selector in case['expected']:
                items = invoke('find_symbol', dict(**selector, limit=50))['data']['items']
                if items:
                    expected.append(items[0]['symbolId'])
                else:
                    unresolved.append((case['id'], selector['qualifiedName']))
            if case['expected'] and not expected:
                continue  # label absent from this snapshot: reported, never scored
            candidates, cursor, seen = [], None, set()
            while True:
                response = invoke('search_code', dict(query=case['query'], mode='hybrid', limit=50, **({'cursor': cursor} if cursor else {})))
                if (response['indexGeneration'], response['queryEpoch']) != key:
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
            collected.append(dict(id=case['id'], category=case['category'], split=case.get('split', 'heldOut'),
                                  expected=expected, candidates=candidates))
        return {'snapshot': list(key), 'unresolved': unresolved, 'cases': collected}
    finally:
        process.stdin.close()
        process.wait(timeout=30)


def name(config):
    arm, lexical = config
    return f'{arm}-lexical{lexical}-floor{FLOOR}'


def distance(config):
    arm, lexical = config
    return (ARMS.index(arm) != ARMS.index(CURRENT[0]), abs(LEXICAL_WEIGHTS.index(lexical) - LEXICAL_WEIGHTS.index(CURRENT[1])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', nargs=2, metavar=('SINGLE', 'VIEWS'), required=True, help='Transport snapshot per arm')
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--collected', required=True, type=Path, help='Reuse or save collected candidate ranks here')
    parser.add_argument('--select', action='store_true', help='Select on this corpus\'s tuning cases')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_bytes())
    if args.collected.exists():
        collected = json.loads(args.collected.read_text())
    else:
        collected = {arm: collect(path, corpus) for arm, path in zip(ARMS, args.snapshot)}
        args.collected.write_text(json.dumps(collected) + '\n')
    configs = [(arm, lexical) for arm in ARMS for lexical in LEXICAL_WEIGHTS]

    def split(config, wanted):
        return [case for case in collected[config[0]]['cases'] if case['split'] == wanted]

    def score(config, wanted):
        cases = split(config, wanted)
        return fusion1.score_cases(cases, (config[1], FLOOR, None)) if cases else None

    trials = [{'config': name(c), 'tuning': score(c, 'tuning'), 'heldOut': score(c, 'heldOut')} for c in configs]
    selected = None
    if args.select:
        # Rule: tuning macro Recall@10, then MRR@10, then the configuration closest to production.
        selected = max(configs, key=lambda c: (round(score(c, 'tuning')['all']['recallAt10'], 9), round(score(c, 'tuning')['all']['mrrAt10'], 9),
                                                tuple(-d for d in distance(c))))
    report = {'corpus': str(args.corpus), 'grid': {'arms': ARMS, 'lexicalWeights': LEXICAL_WEIGHTS, 'floor': FLOOR},
              'current': name(CURRENT), 'selectedOnTuning': name(selected) if selected else None,
              'unresolved': {arm: collected[arm]['unresolved'] for arm in ARMS}, 'trials': trials}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'selected': report['selectedOnTuning'], 'unresolved': {arm: len(v) for arm, v in report['unresolved'].items()}}))
    for trial in trials:
        cell = trial['tuning'] if args.select else trial['heldOut']
        if cell:
            print(f"{trial['config']:28} R@10 {cell['all']['recallAt10']:.3f}  MRR {cell['all']['mrrAt10']:.3f}  n={cell['all']['cases']}")


if __name__ == '__main__':
    main()
