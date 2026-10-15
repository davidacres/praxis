# Relevance evaluation

`../scripts/evaluate-retrieval.py` compares lexical and hybrid search against an explicit version-1 labelled corpus. It queries an already registered/indexed local repository through the packaged CLI. It does not build the repository, restore packages, download models or upload source.

```sh
python3 services/code-intelligence/scripts/evaluate-retrieval.py \
  --executable /absolute/path/to/Praxis.CodeIntelligence \
  --data /absolute/private/evaluation-data \
  --repository REPOSITORY_ID \
  --corpus /absolute/path/maze-labels.praxis.json \
  --output /absolute/path/maze-results.praxis.json
```

Use a disposable source checkout pinned to the declared revision and an isolated service data directory. Install/activate the pinned local model separately, then wait for full current coverage. The runner resolves every relevance selector to exactly one current symbol; ambiguous or missing labels stop evaluation. Pin optional `signature` and `contextId` when needed. Exact source paths are relative to the registered root.

Example **draft** corpus shape (one query cannot satisfy the protocol):

```json
{
  "version": 1,
  "sourceRevision": "61d4510a8ef6946407fa310038ae0add1fffdf24",
  "reviewed": false,
  "reviewedBy": "",
  "nearDuplicateSplitReviewed": false,
  "negativeAbstentionReviewed": false,
  "reviewedExplanationCount": 0,
  "queries": [
    {
      "id": "refresh-token-consume",
      "category": "behaviour",
      "split": "heldOut",
      "query": "consume a refresh token so it cannot be reused",
      "expected": [
        {
          "name": "ValidateAndConsumeRefreshTokenAsync",
          "qualifiedName": "REPLACE_WITH_EXACT_FIND_SYMBOL_QUALIFIED_NAME"
        }
      ],
      "expectedEvidence": ["src/Services/Maze.UserService/Services/RefreshTokenService.cs"],
      "reviewed": false
    }
  ]
}
```

Supported categories are `exact`, `terminology`, `behaviour`, `crossProject`, `negative` and `stale`. Negative cases have an empty `expected` array; other cases require explicit current labels and reviewed source evidence. A stale case labels the correct **current** answer after a separately controlled stale-source scenario; this runner does not create edits or claim it has exercised stale-source transitions.

The protocol requires at least 120 queries, at least 20 per category and a 40 tuning / 80 held-out split. Numerical quality gates use held-out queries only. Exact duplicate normalized queries are rejected across both splits; a human must review near-duplicate leakage and declare that separately. Freeze the split and reviewed labels before tuning; do not revise held-out labels to match retrieved answers.

Recall@10 uses the actual first ten result positions and unique relevant identities; duplicates cannot promote an eleventh result or inflate recall. Empty negative labels earn no recall or MRR. Tool errors retain their latency and count as misses for positive cases. The report includes lexical/hybrid category recall, MRR, nearest-rank p95, individual results and corpus SHA-256. It checks unchanged generation/epoch, complete semantic coverage, unique results, source evidence for returned relevant symbols, exact top-1, hybrid recall >=0.8 and <=0.05 category regression against lexical. Latency includes sequential CLI/owner transport and is not the capacity benchmark.

Exit status 2 means one or more declared gates failed; the report is still written. Status 0 means these automated and **declared review** gates passed, not release approval. Review declarations are supplied assertions, not independently verified human work. Retain the reviewed labels, revision evidence, negative abstention assessment and at least 30 explanation reviews with no unsupported high-impact claims alongside the report. The runner cannot certify those reviews or semantic project coverage from declarations alone.

The user-selected repository is `https://github.com/davidacres/maze`, initially cloned at the revision above. The checkout is separate from Praxis and is reference material, not a target for feature changes. Source-only indexing cannot establish compiler-bound cross-project quality; explicit trusted context capture and coverage verification remain required for that category.

Focused metric safeguards:

```sh
python3 -m unittest discover -s services/code-intelligence/scripts -p 'test_*.py'
```

Set `PRAXIS_CODE_INTELLIGENCE_EXE` to run the additional real packaged-owner fixture. It owns temporary source/data and its process, verifies the CLI report and honest lexical-fallback/draft failure, then cleans up. Native CI runs it on all three supported hosts after packaging.
