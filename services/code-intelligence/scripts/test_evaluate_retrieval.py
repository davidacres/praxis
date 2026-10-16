"""Guard relevance reports against false passes and misleading recall."""
import json
import os
import subprocess
import tempfile
import time
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('retrieval', Path(__file__).with_name('evaluate-retrieval.py'))
retrieval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retrieval)


def corpus():
    queries = []
    for category_index, category in enumerate(sorted(retrieval.CATEGORIES)):
        for index in range(20):
            identity = f'{category}-{index}'
            queries.append({'id': identity, 'category': category, 'query': identity,
                            'split': 'tuning' if index < (7 if category_index < 4 else 6) else 'heldOut',
                            'expected': [] if category == 'negative' else [{'name': identity, 'qualifiedName': identity}],
                            'expectedEvidence': ['Example.cs'], 'reviewed': False})
    return {'version': 1, 'sourceRevision': 'fixture', 'queries': queries}


def owner(semantic=True, change_epoch=False, miss=False, resolution="complete"):
    statuses = 0

    def invoke(tool, arguments):
        nonlocal statuses
        result = {'indexGeneration': 1, 'queryEpoch': 2}
        if tool == 'get_index_status':
            result['data'] = {'contexts': [{'resolution': resolution}]}
            result['freshness'] = {'state': 'current' if resolution == 'complete' else 'partial'}
            statuses += 1
            if change_epoch and statuses > 1:
                result['queryEpoch'] = 3
        elif tool == 'find_symbol':
            result['data'] = {'items': [{'symbolId': arguments['name']}]}
        else:
            identity = arguments['query']
            matches = [] if miss or identity.startswith('negative') else [
                {'symbol': {'symbolId': identity, 'qualifiedName': identity}, 'evidenceIds': ['source']}]
            result['data'] = {'matches': matches, 'channelsUsed': ['lexical', 'vector'] if semantic else ['lexical'],
                              'eligibleSymbolCount': 10, 'vectorCoveredSymbolCount': 10 if semantic else 0}
            result['evidence'] = [{'id': 'source', 'path': 'Example.cs'}]
        return result
    return invoke


class EvaluationTests(unittest.TestCase):
    def test_ambiguous_exact_queries_require_explicit_labels_and_complete_retrieval(self):
        draft = corpus()
        case = next(case for case in draft['queries'] if case['category'] == 'exact' and case['split'] == 'heldOut')
        case['expected'].append({'name': 'second-overload', 'qualifiedName': 'second-overload'})
        with self.assertRaises(ValueError):
            retrieval.validate(draft)
        case['ambiguousExact'] = True
        report = retrieval.evaluate(draft, owner())
        self.assertTrue(report['gates']['exactTop1'])
        self.assertFalse(report['gates']['ambiguousExactRecall'])
        original = owner()
        def both(tool, arguments):
            response = original(tool, arguments)
            if tool == 'search_code' and arguments['query'] == case['query']:
                match = json.loads(json.dumps(response['data']['matches'][0]))
                match['symbol']['symbolId'] = 'second-overload'
                response['data']['matches'].append(match)
            return response
        self.assertTrue(retrieval.evaluate(draft, both)['gates']['ambiguousExactRecall'])
        case['expected'].pop()
        with self.assertRaises(ValueError):
            retrieval.validate(draft)

    def test_duplicates_cannot_promote_eleventh_result_or_inflate_recall(self):
        result = retrieval.score({'target'}, ['other'] * 10 + ['target'])
        self.assertEqual(0, result['recallAt10'])
        self.assertEqual(.5, retrieval.score({'target', 'missing'}, ['target'] * 10)['recallAt10'])
        self.assertIsNone(retrieval.score(set(), [])['recallAt10'])

    def test_draft_cannot_pass_even_with_perfect_retrieval(self):
        report = retrieval.evaluate(corpus(), owner())
        self.assertEqual(1, report['summary']['hybrid/all']['recallAt10'])
        self.assertTrue(report['gates']['fullSemanticCoverage'])
        self.assertFalse(report['gates']['reviewDeclared'])
        self.assertFalse(report['passedDeclaredGates'])

    def test_fallback_cannot_claim_semantic_quality(self):
        report = retrieval.evaluate(corpus(), owner(semantic=False))
        self.assertEqual(1, report['summary']['hybrid/all']['recallAt10'])
        self.assertFalse(report['gates']['fullSemanticCoverage'])

    def test_source_only_context_cannot_pass_compiler_coverage(self):
        report = retrieval.evaluate(corpus(), owner(resolution='syntaxOnly'))
        self.assertEqual(1, report['summary']['hybrid/all']['recallAt10'])
        self.assertFalse(report['gates']['completeCompilerContexts'])

    def test_tuning_only_category_cannot_escape_held_out_regression_gate(self):
        draft = corpus()
        for case in draft['queries']:
            if case['category'] == 'behaviour':
                case['split'] = 'tuning'
        self.assertFalse(retrieval.validate(draft)['heldOutEveryCategory'])

    def test_diagnostic_truncation_does_not_hide_global_compiler_coverage(self):
        native = owner()
        def truncated(tool, arguments):
            result = native(tool, arguments)
            if tool == 'get_index_status':
                result['truncated'] = True
            return result
        self.assertTrue(retrieval.evaluate(corpus(), truncated)['gates']['completeCompilerContexts'])
        native = owner()
        def hidden_partial(tool, arguments):
            result = native(tool, arguments)
            if tool == 'get_index_status':
                result['truncated'] = True
                result['freshness']['state'] = 'partial'
            return result
        self.assertFalse(retrieval.evaluate(corpus(), hidden_partial)['gates']['completeCompilerContexts'])

    def test_changed_epoch_invalidates_snapshot(self):
        self.assertFalse(retrieval.evaluate(corpus(), owner(change_epoch=True))['gates']['stableSnapshot'])

    def test_recall_miss_is_not_reported_as_missing_returned_evidence(self):
        report = retrieval.evaluate(corpus(), owner(miss=True))
        self.assertEqual(0, report['summary']['hybrid/all']['recallAt10'])
        self.assertTrue(report['gates']['expectedEvidencePresent'])
        self.assertFalse(report['gates']['heldOutRecallAtLeast080'])

    def test_duplicate_text_and_malformed_selectors_rejected(self):
        draft = corpus()
        draft['queries'][-1]['query'] = draft['queries'][0]['query'].upper()
        with self.assertRaisesRegex(ValueError, 'Duplicate query'):
            retrieval.validate(draft)
        draft = corpus()
        draft['queries'][0]['expected'] = [None]
        with self.assertRaisesRegex(ValueError, 'Invalid symbol selector'):
            retrieval.validate(draft)

    def test_errors_remain_in_metrics_and_negative_cases_do_not_earn_recall(self):
        cases = [{'mode': 'hybrid', 'split': 'heldOut', 'category': 'exact',
                  'recallAt10': 0, 'mrrAt10': 0, 'latencyMs': 125000, 'error': 'timeout'},
                 {'mode': 'hybrid', 'split': 'heldOut', 'category': 'negative',
                  'recallAt10': None, 'mrrAt10': None, 'latencyMs': 1, 'error': None}]
        result = retrieval.aggregate(cases)['hybrid/all']
        self.assertEqual(0, result['recallAt10'])
        self.assertEqual(1, result['errors'])
        self.assertEqual(125000, result['p95Ms'])
        self.assertEqual(1, result['labelledQueries'])


@unittest.skipUnless(os.environ.get('PRAXIS_CODE_INTELLIGENCE_EXE'), 'Explicit native package fixture required')
class NativeEvaluationTests(unittest.TestCase):
    def test_real_cli_report_stays_draft_and_reports_fallback(self):
        executable = str(Path(os.environ['PRAXIS_CODE_INTELLIGENCE_EXE']).resolve())
        with tempfile.TemporaryDirectory(prefix='pci-eval-') as directory:
            root = Path(directory)
            source, data = root / 'source', root / 'data'
            source.mkdir()
            (source / 'Example.cs').write_text('public class EvaluationExample { public int Compute() => 42; }\n')
            process = subprocess.Popen([executable, 'serve', '--data', str(data)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    if (data / 'owner.json').exists():
                        break
                    if process.poll() is not None:
                        self.fail('Native owner exited before readiness')
                    time.sleep(.1)
                def cli(*arguments):
                    run = subprocess.run([executable, *arguments, '--data', str(data)],
                                         capture_output=True, text=True, timeout=30, check=True)
                    return json.loads(run.stdout)
                repository = cli('register', str(source))['data']['repositoryId']
                cli('index', repository)
                symbol = cli('query', 'find_symbol', json.dumps({'repositoryId': repository, 'name': 'Compute'}))['data']['items'][0]
                draft = {'version': 1, 'sourceRevision': 'synthetic-fixture', 'queries': [
                    {'id': 'compute', 'category': 'exact', 'split': 'heldOut', 'query': 'Compute',
                     'expected': [{'name': 'Compute', 'qualifiedName': symbol['qualifiedName']}],
                     'expectedEvidence': ['Example.cs']}]}
                corpus_path, output = root / 'corpus.praxis.json', root / 'report.praxis.json'
                corpus_path.write_text(json.dumps(draft))
                run = subprocess.run([os.sys.executable, str(Path(retrieval.__file__)),
                                      '--executable', executable, '--data', str(data), '--repository', repository,
                                      '--corpus', str(corpus_path), '--output', str(output)],
                                     capture_output=True, text=True, timeout=90)
                self.assertEqual(2, run.returncode, run.stdout + run.stderr)
                report = json.loads(output.read_text())
                self.assertEqual(1, report['summary']['lexical/all']['recallAt10'])
                self.assertTrue(report['gates']['expectedEvidencePresent'])
                self.assertTrue(report['gates']['noToolErrors'])
                self.assertFalse(report['gates']['fullSemanticCoverage'])
                self.assertFalse(report['passedDeclaredGates'])
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)


if __name__ == '__main__':
    unittest.main()
