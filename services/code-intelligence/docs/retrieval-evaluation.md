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

The protocol requires at least 120 queries, at least 20 per category and a 40 tuning / 80 held-out split. Numerical quality gates use held-out queries only; every category must occur in the held-out split. Complete compiler context coverage is required and reported, so syntax-only indexing cannot pass acceptance. Exact duplicate normalized queries are rejected across both splits; review near-duplicate leakage separately and record the reviewer and method. Section 32 recommends a second human review of a sample where practical; AI source review must be identified as AI review and must not be presented as human approval. Freeze the split and reviewed labels before tuning; do not revise held-out labels to match retrieved answers.

Recall@10 uses the actual first ten result positions and unique relevant identities; duplicates cannot promote an eleventh result or inflate recall. Empty negative labels earn no recall or MRR. Tool errors retain their latency and count as misses for positive cases. The report includes lexical/hybrid category recall, MRR, nearest-rank p95, individual results and corpus SHA-256. It checks unchanged generation/epoch, complete semantic coverage, unique results, source evidence for returned relevant symbols, exact top-1, hybrid recall >=0.8 and <=0.05 category regression against lexical. Latency includes sequential CLI/owner transport and is not the capacity benchmark.

Exit status 2 means one or more declared gates failed; the report is still written. Status 0 means these automated and **declared review** gates passed, not release approval. Review declarations are supplied assertions, not independent proof that review work occurred. Retain the reviewed labels, revision evidence, negative abstention assessment and at least 30 explanation reviews with no unsupported high-impact claims alongside the report. The runner cannot certify those reviews or semantic project coverage from declarations alone.

The user-selected repository is `https://github.com/davidacres/maze`, initially cloned at the revision above. The checkout is separate from Praxis and is reference material, not a target for feature changes. Source-only indexing cannot establish compiler-bound cross-project quality; explicit trusted context capture and coverage verification remain required for that category.

Focused metric safeguards:

```sh
python3 -m unittest discover -s services/code-intelligence/scripts -p 'test_*.py'
```

Set `PRAXIS_CODE_INTELLIGENCE_EXE` to run the additional real packaged-owner fixture. It owns temporary source/data and its process, verifies the CLI report and honest lexical-fallback/draft failure, then cleans up. Native CI runs it on all three supported hosts after packaging.

### Identifier retrieval correction

Adapter `roslyn-5.9/v6` retains original qualified identifiers in lexical documents and appends split terms, including acronym boundaries, namespace segments, underscores and signature parameter types. Displayed symbol identities remain unchanged. The adapter version invalidates unchanged-file snapshots so reindexing republishes the documents. FTS field weights are name 5, signature 3, documentation 1 and description 1. Independent indexed name/qualified-name lookup supplies an exact-match bucket before reciprocal-rank fusion; a symbol contributes at most once per non-graph channel. Schema 3 adds a repository/signature index and includes full-signature equality in the independent exact bucket; name-only lookup retains all matching overloads. Upgrade tests cover schema 1 and 2, retained facts, recoverable backups and index use. These changes need fresh representative relevance measurements; the saved v5 pilot and capacity reports are historical baselines.

### Compiler-backed v6 tuning checkpoint

`maze-compiler-v6-tuning-draft.praxis.json` and `maze-compiler-v6-model-tuning-results.praxis.json` preserve the same 40 pilot texts, source commit, four-project compiler scope and pinned model as the preceding compiler-backed run. The snapshot was explicitly reindexed with adapter v6 and schema 3 before evaluation. Across the 35 positive tuning cases, hybrid macro Recall@10 increased from 27/35 (0.7714) to 29/35 (0.8286); lexical increased from 18/35 (0.5143) to 20/35 (0.5714). Hybrid recovered cases 28 and 29; six misses remain. Lexical also lost case 34, so this is not an across-the-board improvement. Both reports retain complete compiler contexts, full vector coverage, stable snapshots, zero tool errors and source evidence checks. No held-out queries or review declarations were added; these results do not pass the formal 120-query protocol.

Exact-category corpus cases may now declare `ambiguousExact: true` with two or more individually resolvable relevant overload labels. Ordinary exact cases still require one label and the held-out top-1 gate. Ambiguous held-out cases additionally require all labelled overloads in the top ten; finding only one cannot pass the ambiguity gate. The absence of ambiguous cases is not evidence that ambiguity was exercised. The current Maze pilot does not yet contain these cases.

### Controlled source lifecycle coverage

`SourceLifecycleTests.RenameMoveAndDeleteWithdrawOldSourceAliasesRelationshipsAndVectors` exercises a temporary compiler-backed project with the real local model: it renames a called method, moves its source file and removes the file, explicitly updating the passive manifest and publishing each snapshot. Before publication, changed bytes yield `SOURCE_CHANGED` and missing files yield `SOURCE_UNREADABLE`; no unchecked source is returned. After publication, retired symbol IDs are rejected, aliases disappear, calls point to the replacement declaration, source evidence uses the moved path and query epochs advance. Real vector refresh restores complete coverage, excludes retired IDs and deletion leaves no removed declaration vectors, locations or graph edges. The synthetic project entry may legitimately remain. Database integrity is checked throughout. This is controlled correctness coverage, not twenty reviewed stale-category Maze relevance cases or watcher timing evidence.
