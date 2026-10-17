"""Pre-registered fusion experiment 3: lexical term coverage.

Hypothesis: the lexical arm ORs every query term, so a descriptive query fills lexical ranks
with candidates that match one or two incidental words ("over", "tags", "reason") and pushes
vector matches out of the first ten. Scaling each lexical contribution by the share of the
query's terms the candidate actually matches should keep strong lexical matches and demote
incidental ones.

Disclosure: this hypothesis was formed after reading the plan-8 Maze held-out terminology
misses (terminology-11, -14 and -17: vector rank 2-3, lexical recall 0, hybrid recall 0).
The Maze held-out split is therefore not a blind check of this idea; the TypeScript pilot
(whose per-query misses were not inspected for this design) is the less-contaminated one.

Collection is experiment 1/2's (every candidate's channel ranks across all pages, one stable
snapshot) plus, for each lexical candidate, which distinct query terms its search document
matches, read from the owner's index read-only with the same quoted-term FTS5 syntax the
service uses. Selection reads only the tuning cases of the corpus given; held-out cases are
scored and reported, never used to choose. The grid and rule below are fixed before any
candidates are collected; change them only with a new, separately recorded experiment.
"""
import argparse
import importlib.util
import itertools
import json
import sqlite3
from pathlib import Path

# Pre-registered grid. Current production (search plan 8): lexical 4, coverage off, floor 1.
LEXICAL_WEIGHTS = [2, 4, 8]
COVERAGE_EXPONENTS = [0, 1, 2]   # lexical contribution x coverage^p; p = 0 is production
VECTOR_FLOORS = [1, 2]            # keep the top-v vector candidates inside the top 10
CURRENT = (4, 0, 1)

_spec = importlib.util.spec_from_file_location('fusion1', Path(__file__).with_name('fusion-experiment.py'))
fusion1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fusion1)


def terms(query):
    # The service splits on whitespace and quotes each token as an FTS5 phrase. Duplicates
    # (case-insensitively, as unicode61 folds case) count once.
    seen, result = set(), []
    for token in query.split():
        if token.lower() not in seen:
            seen.add(token.lower())
            result.append(token)
    return result


def add_coverage(collected, corpus, database):
    queries = {case['id']: case['query'] for case in corpus['queries']}
    connection = sqlite3.connect(f'file:{database}?mode=ro', uri=True)
    try:
        for case in collected:
            query_terms = terms(queries[case['id']])
            lexical = [c for c in case['candidates'] if 'lexical' in c['ranks']]
            rows = {symbol: search for search, symbol in connection.execute(
                'SELECT search_id, symbol_id FROM search_documents WHERE symbol_id IN (SELECT value FROM json_each(?))',
                (json.dumps([c['symbolId'] for c in lexical]),))}
            matched = {c['symbolId']: 0 for c in lexical}
            for term in query_terms:
                phrase = '"' + term.replace('"', '""') + '"'
                hits = {row for (row,) in connection.execute(
                    'SELECT rowid FROM symbol_fts WHERE symbol_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))',
                    (phrase, json.dumps(list(rows.values()))))}
                for symbol, search in rows.items():
                    matched[symbol] += search in hits
            for candidate in lexical:
                candidate['coverage'] = matched[candidate['symbolId']] / len(query_terms) if query_terms else 1.0
    finally:
        connection.close()
    return collected


def ranked(case, lexical, exponent, floor):
    def score(candidate):
        total = 0.0
        for channel, rank in candidate['ranks'].items():
            if channel == 'lexical':
                total += lexical * candidate.get('coverage', 1.0) ** exponent / (60 + rank)
            else:
                total += (.5 if channel == 'alias' else 1) / (60 + rank)
        return total
    ordered = sorted(case['candidates'], key=lambda c: (-(1 if 'exact' in c['ranks'] else 0), -score(c), c['symbolId']))
    top = ordered[:10]
    by_vector = sorted((c for c in case['candidates'] if 'vector' in c['ranks']), key=lambda c: c['ranks']['vector'])[:floor]
    for candidate in by_vector:
        if candidate in top:
            continue
        for index in range(len(top) - 1, -1, -1):
            if 'exact' not in top[index]['ranks'] and top[index] not in by_vector:
                top[index] = candidate
                break
        else:
            if len(top) < 10:
                top.append(candidate)
    return [c['symbolId'] for c in top]


def score_cases(cases, config):
    original = fusion1.ranked
    fusion1.ranked = lambda case, *args: ranked(case, *args)
    try:
        return fusion1.score_cases(cases, config)
    finally:
        fusion1.ranked = original


def name(config):
    lexical, exponent, floor = config
    return f'lexical{lexical}-coverage{exponent}-floor{floor}'


def distance(config):
    lexical, exponent, floor = config
    return (exponent, floor - CURRENT[2], abs(LEXICAL_WEIGHTS.index(lexical) - LEXICAL_WEIGHTS.index(CURRENT[0])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--collected', type=Path, help='Reuse or save collected candidate ranks and coverage here')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_bytes())
    if args.collected and args.collected.exists():
        collected = json.loads(args.collected.read_text())
    else:
        collected = add_coverage(fusion1.collect(args.executable, args.data, args.repository, corpus), corpus, Path(args.data, 'index.db'))
        if args.collected:
            args.collected.write_text(json.dumps(collected) + '\n')
    tuning = [case for case in collected if case['split'] == 'tuning']
    held_out = [case for case in collected if case['split'] == 'heldOut']
    configs = list(itertools.product(LEXICAL_WEIGHTS, COVERAGE_EXPONENTS, VECTOR_FLOORS))
    trials = [{'config': name(config), 'tuning': score_cases(tuning, config) if tuning else None,
               'heldOut': score_cases(held_out, config) if held_out else None} for config in configs]
    selected = CURRENT
    if tuning:
        # Rule: tuning macro Recall@10, then MRR@10, then the configuration closest to production.
        selected = max(configs, key=lambda c: (round(score_cases(tuning, c)['all']['recallAt10'], 9), round(score_cases(tuning, c)['all']['mrrAt10'], 9),
                                                tuple(-d for d in distance(c))))
    report = {'experiment': 3, 'corpus': str(args.corpus),
              'grid': {'lexicalWeights': LEXICAL_WEIGHTS, 'coverageExponents': COVERAGE_EXPONENTS, 'vectorFloors': VECTOR_FLOORS},
              'current': name(CURRENT), 'selectedOnTuning': name(selected) if tuning else None,
              'currentTuning': score_cases(tuning, CURRENT) if tuning else None,
              'selectedTuning': score_cases(tuning, selected) if tuning else None,
              'currentHeldOut': score_cases(held_out, CURRENT) if held_out else None,
              'selectedHeldOut': score_cases(held_out, selected) if held_out else None, 'trials': trials}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'selected': report['selectedOnTuning'], 'currentTuning': (report['currentTuning'] or {}).get('all'),
                      'selectedTuning': (report['selectedTuning'] or {}).get('all')}))


if __name__ == '__main__':
    main()
