"""Replay an existing native-evaluator corpus through a frozen production engine."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import time


def evaluate(snapshot_path, corpus_path, output):
    snapshot = json.loads(snapshot_path.read_text())
    corpus_bytes = corpus_path.read_bytes()
    corpus = json.loads(corpus_bytes)
    evaluator_path = Path(__file__).resolve().parents[5] / 'services/code-intelligence/scripts/evaluate-retrieval.py'
    spec = importlib.util.spec_from_file_location('native_evaluator', evaluator_path)
    evaluator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evaluator)
    output.mkdir(parents=True, exist_ok=False)
    database_hash = lambda: hashlib.file_digest(Path(snapshot['database']).open('rb'), 'sha256').hexdigest()
    before_hash = database_hash()
    process = subprocess.Popen(['dotnet', snapshot['transport'], snapshot['database'], snapshot['models']],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                               stderr=(output/'engine.stderr.log').open('w'), bufsize=1)
    raw = (output/'raw.praxis.jsonl').open('w')
    def call(tool, arguments):
        request = {'tool': tool, 'arguments': {'repositoryId': snapshot['repositoryId'], 'responseBudgetTokens': 8000, **arguments}}
        started = time.perf_counter()
        process.stdin.write(json.dumps(request)+'\n'); process.stdin.flush()
        line = process.stdout.readline()
        if not line: raise RuntimeError('Production engine stopped')
        response = json.loads(line)
        raw.write(json.dumps({'request': request, 'response': response, 'latencyMs': (time.perf_counter()-started)*1000})+'\n'); raw.flush()
        return response
    calls = 0
    def invoke(tool, arguments):
        nonlocal calls
        response = call(tool, arguments)
        if tool == 'search_code':
            first = response
            matches = list(first.get('data', {}).get('matches', []))
            evidence = {e['id']: e for e in first.get('evidence', [])}
            cursor = response.get('nextCursor')
            while len(matches) < 10 and cursor and not response.get('error'):
                response = call(tool, {**arguments, 'cursor': cursor})
                page = response.get('data', {}).get('matches', [])
                if response.get('error'): first['error'] = response['error']
                if not page: break
                matches.extend(page); evidence.update({e['id']: e for e in response.get('evidence', [])}); cursor = response.get('nextCursor')
            if 'data' in first: first['data']['matches'] = matches[:10]
            first['evidence'] = list(evidence.values()); response = first
            calls += 1
            if calls % 30 == 0: print(f'{calls} mode comparisons', flush=True)
        return response
    try:
        engine = invoke('benchmark_metadata', {})
        # Validate every expected selector's source before measuring retrieval.
        for case in corpus['queries']:
            for selector in case['expected']:
                found = invoke('find_symbol', {**selector, 'limit':50})
                assert not found.get('error') and len(found['data']['items']) == 1, case['id']
                source = invoke('get_source', {'symbolId':found['data']['items'][0]['symbolId']})
                assert not source.get('error') and source['data']['fragments'], case['id']
                assert all(f['matchesIndexedRevision'] and f['currentHash'] == f['indexedHash'] for f in source['data']['fragments']), case['id']
        report = evaluator.evaluate(corpus, invoke)
        report.update(measurement='Sequential production query engine on private snapshot; no owner/CLI overhead',
                      corpusHash='sha256:'+hashlib.sha256(corpus_bytes).hexdigest(), engine=engine,
                      databaseUnchanged=before_hash == database_hash(), independentHumanReviewCompleted=False,
                      releaseAcceptanceClaimed=False)
        (output/'results.praxis.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps({'summary': {k:v for k,v in report['summary'].items() if k.endswith('/all')},
                          'gates': report['gates'], 'databaseUnchanged':report['databaseUnchanged']}, indent=2))
    finally:
        raw.close(); process.stdin.close(); process.wait(timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(); evaluate(args.snapshot, args.corpus, args.output)
