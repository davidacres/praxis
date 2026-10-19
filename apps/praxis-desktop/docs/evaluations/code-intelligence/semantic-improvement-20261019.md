# Semantic retrieval and path discovery improvement

19 October 2026. Implementation and measured production-engine replay; no model-weight change.

Follow-up: [broader validation](extended-validation-20261019.md) tests additional scopes, records a language-scope correction (representation format 5), and preserves the original desktop scores. The blinded relevance packet is prepared, not independently scored. The 70% target is **primary implementation anchor found in the first ten semantic-only results for natural-language questions**. It is not answer correctness or complete path discovery.

## Results

| Fixed natural-language set | Before | After | Before MRR@10 | After MRR@10 |
| --- | ---: | ---: | ---: | ---: |
| Original 64 questions, now development | 40/64 (62.5%) | **46/64 (71.9%)** | 0.373 | 0.511 |
| All 96 development questions | 52/96 (54.2%) | **67/96 (69.8%)** | 0.321 | 0.474 |
| Fresh 40-question acceptance | 23/40 (57.5%) | **35/40 (87.5%)** | 0.359 | 0.542 |

The fresh set contains 20 additional behaviours, two questions each. It was frozen before candidate collection and searched only after selection. Twelve questions changed from miss to hit; none changed from hit to miss. Paired family-bootstrap Hit@10 improvement: **+30 percentage points, 95% interval +15 to +47.5**, 10,000 resamples, seed 20261019. This interval describes this AI-authored desktop sample; it does not remove selection or label bias. Some acceptance behaviours share components with development cases. Independent human relevance review remains outstanding.

The original 64-question comparison exceeds 70%, as does fresh acceptance. The broader development score is **below 70%**; do not round it up or omit it. Labels, prompts, top-k, candidate eligibility and model weights were not changed to meet the target. Exact-name controls remain separate: **48/48 found in the first ten**, MRR 0.944.

## Five iterations and further experiments

The five predeclared query-only iterations were evaluated, including failed candidates and the previous candidate as a control:

| Iteration | Experiment | Selected all-96 hits | Selected original-64 hits |
| --- | --- | ---: | ---: |
| 1 | Remove question framing | 52 | 40 |
| 2 | Mix original and compact/instructional embeddings | 52 | 40 |
| 3 | Fuse semantic rankings | 52 | 40 |
| 4 | Bound results per source file | 52 | 40 |
| 5 | Add bounded clause views | 53 | 40 |

These did **not** reach the target. A subsequent readable-name-only representation rebuild regressed the original comparison to 38/64 and was rejected. A source-derived semantic header, balanced with source-body similarity, improved it to 43/64. Adding bounded semantic query views and selecting fusion weights on development reached 46/64. Normalized vector blends and file diversity were also tested and rejected. This was more than five attempts, not five uniformly successful improvements.

See `semantic-experiment-plan.md`. Full failed candidates and raw responses remain in the session artifacts; acceptance was not used to choose any of them. The expanded tuning search makes the old split development evidence, regardless of its historical `heldOut` field.

## Implementation

Shared native service files are under `services/code-intelligence`:

- `SemanticHeaderBuilder.cs`: deterministic readable names, documentation, module/signature and bounded resolved caller/callee context for slash-qualified TypeScript/JavaScript symbols. No generated answers, query labels or synonym tables.
- `SymbolRepresentation.cs`, `LocalModel.cs`: one semantic-header vector and at most three legacy source vectors, preserving the four-vector bound and verbatim source coordinates. Native C# document text stays unchanged. A long symbol can lose its previous fourth source chunk; this is a coverage trade-off, not extra unlimited context.
- `ModelStore.cs`: average header similarity and best source similarity. Vector-mode code search uses up to five query views; original-view weight 2, other weights 1, reciprocal-rank fusion k=5. Every view retrieves semantically. There is no lexical fallback or test-file exclusion in the reported vector results. Hybrid retains its existing lexical/vector fusion and uses only the original semantic query.
- `EmbeddingReuse.cs`, `RepositoryIndexer.cs`: representation format 4 forces an older index to republish, preserves source-hash validation and valid vector reuse, and refreshes source-derived context when facts change. Repeated activation has a dedicated reuse regression.
- `QueryService.cs`: search plan 10; graph response trimming removes external endpoints before local helpers instead of dropping half the node list. Root, endpoint consistency, evidence and truncation boundaries remain checked.

The pinned bge-small model, tokenizer, model manifest, golden model fixture and licence are unchanged. Model inference may happen up to five times per vector query; candidate scoring scans validated vectors per view. This costs additional CPU/latency, with no claim that this desktop experiment meets the separate 50,000-symbol performance gates. Rebuilding embeddings also takes time and temporarily reduces semantic coverage until activation completes. No application reload or live owner-index mutation was performed.


## Three-mode regression replay

All **504 comparisons** completed on the unchanged 168-query corpus. All checks passed: no tool errors, no duplicates, source evidence present, complete vector coverage, stable generation/epoch and unchanged database bytes.

On the original 64 natural-language questions (now development): lexical remains **33/64, MRR 0.310**; semantic is **46/64, MRR 0.511**; hybrid improves from **39/64 to 42/64**, but its MRR decreases from **0.428 to 0.413**. No evaluated domain loses primary-anchor Hit@10 in either semantic or hybrid. Hybrid accuracy and ranking are different measures; the MRR regression is retained here.

Observed warm-engine p50/p95 query latency in this diagnostic run: lexical **46/73 ms**, semantic **1,275/2,888 ms**, hybrid **660/840 ms**. These collect top-20 pages and some collection overlapped other checks; they are not a controlled before/after speed test or release-scale performance acceptance. The selected semantic candidate is materially more expensive and needs performance qualification before release. The 70% accuracy target does not establish a latency target.

## Code-path evaluation

`path-corpus.praxis.json` fixes 12 scenarios with entry points, required nodes/edges, source evidence and explicit IPC/callback/external boundaries. `evaluate_paths.py` uses the first three search results as seeds, not the labelled correct seed. Both engines use outgoing calls, depth 4, 100-node/200-edge caps and the same 8,000-token response budget.

| Measure | Before | After |
| --- | ---: | ---: |
| Entry point in semantic top ten | 7/12 (58.3%) | **11/12 (91.7%)** |
| Complete trace from the correct entry (oracle) | 9/12 (75.0%) | **12/12 (100%)** |
| Complete discovery from first three search results | 3/12 (25.0%) | **8/12 (66.7%)** |
| Mean required-edge recall from those seeds | 25.0% | **66.7%** |

The remaining end-to-end misses concern provider replacement, Git hunk application, workflow preflight and system-theme following. In three cases the correct entry is in the top ten but outside the three-seed budget. Static reachability does not establish runtime execution, branch feasibility or edges across IPC/dynamic callbacks. Complete path discovery remains below 70%; this score must not be presented as the semantic Hit@10 target.

## Verification and evidence

Production replay uses the same frozen 597-file source manifest, original generation 79, private SQLite backups and the pinned model. Candidate vector coverage is complete for all 21,583 eligible symbols; query epoch 192 is fixed during its runs. Dataset SHA-256 values:

- Original retrieval: `21d0060111e226f93c0c6ff0e4b641c9f4ff5d4c0e88edd3f1b6da5a64349aa4`.
- Fresh acceptance: `44c283fc3882437b423cac1609b3addac98807d1bd3caac2f5b9544e051185f8`.
- Path scenarios: `431093393968c49b0474b03911f0b84282ab9081c605a95138490b543b6ca6bf`.

Evidence root: `.praxis/session-artifacts/code-intelligence-benchmark/`:

- `semantic-five-development/`: all five initial experiments and rejected variants.
- `header-development/`, `header-query-development/`, `header-blend-development/`, `header-limited-query-development/`: representation, query and fusion experiments.
- `semantic-native-development/`, `semantic-native-controls/`: actual production QueryService results and raw envelopes.
- `semantic-baseline-acceptance/`, `semantic-native-acceptance/`, `semantic-acceptance-comparison.praxis.json`: fresh paired acceptance and family interval.
- `path-baseline/`, `path-candidate/`, `path-final-native/`: baseline, graph candidate and integrated path results.
- `semantic-native-all-modes/`: full three-mode regression replay, including original false-premise questions. Those are diagnostic retrieval results, not an agent premise-correction score.

**Native verification:** build passed with zero warnings/errors; the full configured service suite passed **197/197**, with zero failures or skips (`service-tests.trx`). This includes TypeScript cross-project calls, source lifecycle, model golden vectors, graph-budget preservation, representation upgrades, semantic views and repeated activation. The initial unconfigured full run lacked model/compiler settings; reruns supplied `PRAXIS_DOTNET`, `PRAXIS_TYPESCRIPT_ROOT` and `PRAXIS_MODEL_BUNDLE`. A snapshot-backfill fixture was adjusted to retain the current representation version; the separate upgrade test verifies old representations rebuild. No application UI tests were needed for these service-only changes.

Frozen desktop and tested native source archives, source/snapshot manifests and the guarded promotion checks are preserved alongside the results. The final vector-reuse correction changes cache retention, not ranking; its production-engine acceptance replay is preserved in `semantic-final-reuse-replay/` and matches all 40 result lists and ranks exactly. The actual shared-source build also passed into an isolated output directory; no running-app binaries were replaced.

`evaluate_semantic.py` resolves each selector and checks current source hashes before searching, follows response-budget pagination without changing the first-ten rank slots, and records stable generation/epoch, errors, duplicate results and actual vector coverage. Reproduction requires the actual frozen source plus working-tree edits, not just the Git commit. Use `prepare_snapshot.py` with the built candidate service, activate the model on the private backup, then pass its snapshot JSON to the evaluators. Do not run activation against the live owner database.

Agent-answer comparisons, independent relevance pooling, other-language relevance acceptance, the separate lifecycle evaluation scenarios and release-scale latency qualification remain unrun. Existing native unit/integration lifecycle tests are distinct from those authored evaluation scenarios. No UI changed; no visual verification was required or performed.
