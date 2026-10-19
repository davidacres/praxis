"""Focused checks for the new review scorer, using disposable packets."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('review_scorer',Path(__file__).with_name('score_blinded_review.py'))
review=importlib.util.module_from_spec(spec);spec.loader.exec_module(review)


class ReviewScoringTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.rows=[{'questionId':'Q1','resultId':'Q1-R1','reviewer':'Example human','grade':3,'rationale':'Implements the condition.','citation':'source.ts:1','needsMoreContext':False},
                   {'questionId':'Q1','resultId':'Q1-R2','reviewer':'Example human','grade':0,'rationale':'Unrelated operation.','citation':'other.ts:1','needsMoreContext':False}]
        key={'questions':[{'id':'Q1','items':[{'id':'Q1-R1','origins':[{'arm':1,'rank':1}]},{'id':'Q1-R2','origins':[{'arm':0,'rank':1}]}]}]}
        (self.root/'review-key.praxis.json').write_text(json.dumps(key))
    def tearDown(self):self.temp.cleanup()
    def execute(self):
        (self.root/'judgments.praxis.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in self.rows))
        return review.score(self.root,self.root/'result.json')
    def test_scores_relevance_without_asserting_independence(self):
        result=self.execute();self.assertEqual(0,result['baselineHits']);self.assertEqual(1,result['candidateHits']);self.assertFalse(result['independenceVerified'])
    def test_rejects_blank_grades(self):
        self.rows[0]['grade']=None
        with self.assertRaises(ValueError):self.execute()
    def test_rejects_boolean_grades(self):
        self.rows[0]['grade']=True
        with self.assertRaises(ValueError):self.execute()
    def test_rejects_duplicate_ratings(self):
        self.rows.append(self.rows[0])
        with self.assertRaises(ValueError):self.execute()
    def test_rejects_incomplete_packet(self):
        self.rows.pop()
        with self.assertRaises(ValueError):self.execute()
    def test_rejects_missing_citations(self):
        self.rows[0]['citation']=''
        with self.assertRaises(ValueError):self.execute()
    def test_rejects_unresolved_context(self):
        self.rows[0]['needsMoreContext']=True
        with self.assertRaises(ValueError):self.execute()


if __name__=='__main__':unittest.main()
