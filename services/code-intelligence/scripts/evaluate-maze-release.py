"""Run the frozen Maze corpus in a private, explicitly mutated source overlay.

Reads an existing SDK capture and provisioned model; never builds, restores or
changes the supplied repository. The fixture directory must not already exist.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import time


def digest(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'manifest', 'corpus', 'fixture', 'executable', 'model', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    if not str(args.output).endswith('.praxis.json'):
        parser.error('Output must end in .praxis.json')
    source, fixture = args.source.resolve(), args.fixture.absolute()
    if fixture.exists() or fixture == source or source in fixture.parents or fixture in source.parents:
        parser.error('Fixture must be a new directory outside the supplied repository')
    raw_corpus = args.corpus.read_bytes()
    corpus = json.loads(raw_corpus)
    revision = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], check=True,
                              capture_output=True, text=True).stdout.strip()
    if revision != corpus['sourceRevision']:
        raise ValueError('Source Git revision differs from the frozen corpus')
    manifest = json.loads(args.manifest.read_bytes())
    files = sorted({path for project in manifest['projects']
                    for key in ('sources', 'supportSources') for path in project.get(key, [])})
    def safe_relative(path):
        relative = PurePosixPath(path)
        if relative.is_absolute() or '..' in relative.parts or '\\' in path:
            raise ValueError('Unsafe captured source path')
        return Path(*relative.parts)
    for case in corpus['queries']:
        review = case.get('sourceReview')
        if review and digest((source / safe_relative(review['path'])).read_bytes()) != review['contentHash']:
            raise ValueError('Reviewed source changed: ' + case['id'])
    root, data = fixture / 'source', fixture / 'data'
    root.mkdir(parents=True)
    snapshot = {}
    captured_inputs = sorted({item['path'] for project in manifest['projects'] for item in project.get('inputs', [])
                              if not Path(item['path']).is_absolute()})
    for path in sorted(set(files + captured_inputs)):
        relative = safe_relative(path)
        original = source / relative
        if original.resolve() != original or original.is_symlink():
            raise ValueError('Source links are not copied')
        raw = original.read_bytes()
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Captured source exceeds service byte limit')
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
        snapshot[path] = digest(raw)
    capture = root / 'context.praxis.json'
    capture.write_text(json.dumps(manifest, indent=2) + '\n')
    executable = str(args.executable.resolve())
    owner = subprocess.Popen([executable, 'serve', '--data', str(data)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            if (data / 'owner.json').exists():
                break
            if owner.poll() is not None:
                raise RuntimeError('Owned service exited before readiness')
            time.sleep(.1)
        def cli(*arguments):
            result = subprocess.run([executable, *arguments, '--data', str(data)], capture_output=True,
                                    text=True, timeout=125, check=False)
            response = json.loads(result.stdout)
            if result.returncode or response.get('error'):
                raise RuntimeError('Fixture operation failed: ' + json.dumps(response))
            return response
        repository = cli('register', str(root), '--manifest', capture.name)['data']['repositoryId']
        def invoke(tool, arguments):
            result = subprocess.run([executable, 'query', tool, json.dumps({**arguments,
                                    'repositoryId': repository, 'responseBudgetTokens': 8000}),
                                     '--data', str(data)], capture_output=True, text=True, timeout=125, check=False)
            response = json.loads(result.stdout)
            if result.returncode and not response.get('error'):
                raise RuntimeError('Query failed without an error envelope')
            return response
        def current(selector):
            response = invoke('find_symbol', {**selector, 'limit': 50})
            if response.get('error') or len(response.get('data', {}).get('items', [])) != 1:
                raise ValueError('Current declaration does not resolve uniquely: ' + str(selector))
            return response['data']['items'][0]
        cli('index', repository)
        # Pause observation while changing the private fixture; source reads still
        # verify bytes against the old snapshot. Resume explicitly republishes it.
        cli('pause', repository)
        stale = [case for case in corpus['queries'] if case['category'] == 'stale']
        transitions = []
        mappings = {case['transition']['oldName']: case['transition']['newName'] for case in stale}
        for case in stale:
            transition = case['transition']
            symbol = current({'name': transition['oldName'], 'qualifiedName': transition['oldQualifiedName']})
            before = invoke('get_source', {'symbolId': symbol['symbolId']})
            if before.get('error'):
                raise ValueError('Baseline source was unavailable')
            transitions.append({'id': case['id'], 'oldSymbolId': symbol['symbolId'],
                                'beforeHash': before['data']['fragments'][0]['currentHash'], **transition})
        pattern = re.compile(r'\b(' + '|'.join(re.escape(name) for name in sorted(mappings, key=len, reverse=True)) + r')\b')
        for path in files:
            target = root / safe_relative(path)
            text = target.read_text(encoding='utf-8')
            target.write_text(pattern.sub(lambda match: mappings[match.group()], text), encoding='utf-8')
        for case in stale:
            transition = case['transition']
            original = root / safe_relative(transition['originalPath'])
            destination = root / safe_relative(transition['currentPath'])
            destination.parent.mkdir(parents=True, exist_ok=True)
            original.rename(destination)
            for project in manifest['projects']:
                project['sources'] = [transition['currentPath'] if path == transition['originalPath'] else path
                                      for path in project['sources']]
        capture.write_text(json.dumps(manifest, indent=2) + '\n')
        for proof in transitions:
            error = invoke('get_source', {'symbolId': proof['oldSymbolId']}).get('error', {}).get('code')
            proof['unpublishedSourceError'] = error
            if error != 'SOURCE_UNREADABLE':
                raise ValueError('Moved source did not fail closed')
        cli('resume', repository)
        for case, proof in zip(stale, transitions):
            retired = invoke('get_symbol', {'symbolId': proof['oldSymbolId']})
            proof['retiredSymbolError'] = retired.get('error', {}).get('code')
            symbol = current(case['expected'][0])
            after = invoke('get_source', {'symbolId': symbol['symbolId']})
            paths = [item.get('path') for item in after.get('evidence', [])]
            proof.update(newSymbolId=symbol['symbolId'], afterHash=after.get('data', {}).get('fragments', [{}])[0].get('currentHash'),
                         movedSourceEvidence=proof['currentPath'] in paths)
            if proof['retiredSymbolError'] != 'SYMBOL_NOT_FOUND' or after.get('error') or not proof['movedSourceEvidence']:
                raise ValueError('Rename publication retained old identity or invalid source')
        installed = cli('model-install', str(args.model.resolve()))
        cli('model-activate', repository, installed['data']['fingerprint'])
        print('Controlled transitions verified; waiting for the provisioned model', flush=True)
        for _ in range(600):
            status = invoke('get_index_status', {})
            models = status.get('data', {}).get('models', [])
            jobs = status.get('data', {}).get('jobsByState', {})
            if any(model['state'] == 'active' for model in models) and not jobs.get('pending') and not jobs.get('leased'):
                break
            time.sleep(1)
        else:
            raise TimeoutError('Model activation did not settle')
        spec = importlib.util.spec_from_file_location('retrieval', Path(__file__).with_name('evaluate-retrieval.py'))
        evaluation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(evaluation)
        report = evaluation.evaluate(corpus, invoke)
        report.update(corpusHash=digest(raw_corpus), sourceRevisionVerified=revision,
                      originalInputHashes=snapshot, controlledTransitions=transitions,
                      fixtureRepositoryId=repository, fixtureRoot=str(root), modelFingerprint=installed['data']['fingerprint'])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'output': str(args.output), 'summary': report['summary'], 'gates': report['gates']}), flush=True)
        return 0 if report['passedDeclaredGates'] else 2
    finally:
        if owner.poll() is None:
            owner.send_signal(signal.SIGINT)
            try:
                owner.wait(timeout=5)
            except subprocess.TimeoutExpired:
                owner.kill()
                owner.wait(timeout=5)


if __name__ == '__main__':
    raise SystemExit(main())
