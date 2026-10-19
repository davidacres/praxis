# Five semantic improvement iterations

Frozen before candidate collection, 19 October 2026. The 70% goal means primary-anchor semantic-only Hit@10 on natural-language questions, not exact names, path coverage or agent-answer quality. The previous 64-question result is now development evidence; no prompts, targets, denominators or result positions will be changed to reach the goal.

Fresh acceptance: `semantic-acceptance.praxis.json`, SHA-256 `44c283fc3882437b423cac1609b3addac98807d1bd3caac2f5b9544e051185f8`, 40 questions over 20 additional target behaviours. It is AI-authored, not independent human review. Its answers were resolved from the frozen source/index without searching those questions. Some new behaviours share components with development data, so this is a new-query acceptance check rather than an independent-repository test. Freeze the file before candidate collection; do not use its results for selecting among the five iterations.

All experiments keep bge-small weights, query instruction, document vectors and candidate eligibility unchanged. Only semantic query representation and semantic ranking may change. No lexical/alias results, benchmark-specific synonym maps, per-question overrides or test-file exclusions are allowed.

1. Remove conversational question framing before embedding. Evaluate a compact-query candidate against the production query.
2. Combine original and compact/instructional query embeddings. Compare a small predeclared mix of 1:1 and 2:1 original-to-alternative weights; select on development only.
3. Fuse the semantic rankings of original, compact and instructional views using reciprocal ranks (k = 20 or 60). No keyword retrieval is introduced.
4. Test bounded file diversity on the best semantic rankings: retain at most two or three results from a source file in the first ten, then append deferred results so paging does not lose candidates. Also keep the unmodified prior candidate as a control.
5. Test bounded clause views for multi-part behaviour questions, fused with original/compact views. At most two clauses, at least four words each; no generated answers. Evaluate with and without the selected diversity bound.

Choose the final candidate by development Hit@10, then MRR@10, then fewer inference calls and the smaller change. Retain failing candidates and regressions. Run fresh acceptance only after selection. Report both the original fixed 64-query comparison and fresh acceptance, even if the 70% target is missed. Exact-name controls and graph correctness remain separate checks. A candidate reaching the numerical target still needs production integration, regression tests and a production-engine replay.

Path discovery: add fixed natural-language scenarios with an entry point, mandatory nodes/edges and explicit unsupported transport/callback boundaries. Score semantic entry retrieval separately from graph reachability from the correct entry, and from end-to-end discovery using the retrieved entries. Static graph reachability is not proof of runtime execution or branch feasibility.


## Representation follow-up after the five query experiments

The five query-only experiments did not reach 70%; their best selected candidate found 40/64 on the original comparison. Retain them as failed attempts. The next candidate changes document construction for TypeScript path-qualified identities: readable camel/acronym words and removal of repeated directory prefixes from the generated header, while preserving original symbol identity, evidence and verbatim source spans. It does not change model weights, tokenization, result eligibility or C# document text. Existing source-aware chunk limits remain unchanged. Rebuild all eligible vectors in a private snapshot, then evaluate the original query against the fixed development set before considering fresh acceptance. No acceptance scores are used to choose the representation.

Separately, the path baseline found 9/12 complete oracle traces and 3/12 complete discoveries from three semantic seeds. Three oracle misses were caused by response-budget trimming. The graph candidate trims external boundary endpoints before local functions and removes only the necessary nodes, retaining root, referenced evidence and explicit truncation boundaries. Test it on the same frozen path cases with the same response budget.

## Final selection log

The readable-name-only representation was rejected after development replay. Further development experiments tested source-derived headers, header/source score averaging, normalized vector blends, bounded query views, fusion k/original weight and file diversity. The selected format-4 candidate averages header and source scores, uses at most four document vectors and five query views, with RRF k=5 and original weight 2. It scored 67/96 overall development and 46/64 on the original comparison in the actual production engine. Only then were the frozen 40 acceptance questions searched: baseline 23/40, candidate 35/40. No acceptance score selected a ranking profile. A subsequent cache-reuse fix retained identical acceptance rankings. Full results, failures, path scores, tests and performance caveats are in `semantic-improvement-20261019.md`.
