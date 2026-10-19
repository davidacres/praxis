"""Validate the benchmark labels and split without running held-out searches."""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re


def validate(root, directory):
    corpus = json.loads((directory / 'retrieval-corpus.praxis.json').read_text())
    proof = json.loads((directory / 'label-evidence.praxis.json').read_text())
    agents = json.loads((directory / 'agent-cases.praxis.json').read_text())
    lifecycle = json.loads((directory / 'lifecycle-cases.praxis.json').read_text())
    evaluator = root.parents[1] / 'services/code-intelligence/scripts/evaluate-retrieval.py'
    spec = importlib.util.spec_from_file_location('retrieval_evaluator', evaluator)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    protocol = module.validate(corpus)
    families = {family['id']: family for family in corpus['families']}
    assert len(families) == len(corpus['families']) == 48, 'Family ids or count'
    evidence = {label['id']: label for label in proof['labels']}
    source_splits = {}
    for family in families.values():
        path = family['path']
        text = (root / path).read_bytes()
        actual = hashlib.sha256(text).hexdigest()
        assert actual == family['sourceSha256'], f'Source drift: {path}'
        label = evidence[family['id']]
        assert label['sourceSha256'] == actual, f'Indexed label drift: {path}'
        assert label['resolution'] == 'resolved', f'Unresolved label: {family["id"]}'
        assert all(part['matchesIndexedRevision'] for part in label['fragments']), 'Stale evidence'
        assert label['generation'] == 79 and label['epoch'] == 169, 'Mixed label snapshots'
        assert family['selector']['qualifiedName'] == label['qualifiedName'], 'Selector mismatch'
        assert re.search(r'\bfunction\s+' + re.escape(family['name']) + r'\s*[(<]', text.decode()), 'Missing declaration'
        source_splits.setdefault(path, set()).add(family['split'])
    assert all(len(splits) == 1 for splits in source_splits.values()), 'Source-file split leakage'
    queries = corpus['queries']
    assert len(queries) == 168, 'Query count'
    for query in queries:
        family = families[query['familyId']]
        assert query['split'] == family['split'], 'Family split leakage'
        if query['category'] == 'negative':
            assert query['requiredCorrection'] and query['counterEvidence'], 'Negative has no oracle'
            assert query['retrievalAbstentionExpected'] is False, 'False premise is not empty-result abstention'
        else:
            assert query['expected'] == [family['selector']], 'Unresolved or inconsistent selector'
            assert query['expectedEvidence'] == [family['path']], 'Incorrect evidence path'
            assert query['requiredAnswerPoints'] == family['facts'], 'Inconsistent answer oracle'
            assert query['judgments'][0]['grade'] == 3, 'Missing direct relevance judgment'
            for judgment in query['judgments']:
                target = next(f for f in families.values() if f['selector'] == judgment['selector'])
                assert target['split'] == family['split'], 'Supporting-label split leakage'
    assert Counter(q['category'] for q in queries) == {'exact': 48, 'terminology': 48, 'behaviour': 48, 'negative': 24}
    assert len(agents['tasks']) == 12, 'Agent task count'
    assert len({task['id'] for task in agents['tasks']}) == 12, 'Duplicate agent task id'
    for task in agents['tasks']:
        assert all(families[id]['split'] == task['split'] for id in task['familyIds']), 'Agent split leakage'
        assert {point['familyId'] for point in task['answerChecklist']} == set(task['familyIds']), 'Missing answer oracle'
        assert {point['familyId'] for point in task['requiredEvidence']} == set(task['familyIds']), 'Missing evidence'
        for item in task['requiredEvidence']:
            assert item['selector'] == families[item['familyId']]['selector'], 'Agent selector mismatch'
    assert len(lifecycle['cases']) == 6, 'Lifecycle case count'
    assert len({case['id'] for case in lifecycle['cases']}) == 6, 'Duplicate lifecycle id'
    assert all(case['expected'] for case in lifecycle['cases']), 'Missing lifecycle oracle'
    assert lifecycle['status'] == 'authored; not executed', 'Unsupported lifecycle execution claim'
    assert agents['status'] == 'authored; not executed', 'Unsupported agent execution claim'
    return {
        'valid': True,
        'queries': len(queries), 'families': len(families),
        'domains': len({f['domain'] for f in families.values()}),
        'sourceFiles': len(source_splits),
        'querySplits': dict(Counter(q['split'] for q in queries)),
        'positiveFamilySplits': dict(Counter(f['split'] for f in families.values())),
        'agentTaskSplits': dict(Counter(t['split'] for t in agents['tasks'])),
        'lifecycleCases': len(lifecycle['cases']),
        'corpusSha256': hashlib.sha256((directory / 'retrieval-corpus.praxis.json').read_bytes()).hexdigest(),
        'existingReleaseProtocolDeclarations': protocol,
        'releaseAcceptanceClaimed': False,
        'rankingQueriesExecutedByValidator': 0,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = validate(args.root.resolve(), Path(__file__).resolve().parent)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
