# Code intelligence evaluation set

Created 19 October 2026. The three-mode retrieval baseline has now run after [five self-review passes](self-review.md); see [measured results](run-20261019.md). Agent comparisons and lifecycle scenarios remain unexecuted. All labels have AI source review, with independent relevance review still pending.

The subsequent [semantic improvement and path-discovery run](semantic-improvement-20261019.md) reached 35/40 on fresh acceptance. It records failed experiments, development results, path completeness, tests and remaining limits. The original retrieval split is now development data for those improvements.

The [broader validation follow-up](extended-validation-20261019.md) adds a separate JavaScript project, replays Maze and the shared-core TypeScript pilot, measures sequential latency, and prepares a blinded human-review packet. It also records the explicit language-scope correction and representation format 5. Human relevance scoring remains pending.

The [shared-scan optimization](shared-scan-20261019.md) preserves the evaluated top-ten results while reducing median semantic latency from 716 to 435 ms in a paired run. It recovers part of the slowdown; the original pre-feature latency remains lower.

The [Release timing and language comparison](release-timing-20261019.md) qualifies those earlier timings as Debug measurements. The current Release service returns desktop and broader TypeScript semantic results at 269–294 ms median, below the user's half-second guideline on the tested warm requests. Accuracy is preserved; the existing JavaScript hybrid regression remains unresolved.

This suite answers two separate questions:

1. Does semantic or hybrid retrieval find useful code more reliably than lexical search?
2. Does giving an agent code intelligence improve its explanation compared with the same agent using files and text search?

The earlier [30-question workflow pilot](../../code-intelligence-workflow-search-pilot.md) remains a historical development baseline. This set does not replace its recorded results.

## Contents and coverage

| Artifact | Contents |
| --- | --- |
| `retrieval-corpus.praxis.json` | 168 queries, exact selectors, source evidence, answer points, relevance judgments and family splits |
| `label-evidence.praxis.json` | Actual index identities, declaration locations, source hashes and current-source checks for all 48 primary labels |
| `agent-cases.praxis.json` | 12 read-only analysis tasks, four comparison arms and answer rubrics |
| `lifecycle-cases.praxis.json` | Six controlled fixture scenarios, including cross-project calls and rename/move/delete transitions; authored, not executed |
| `validate.py` | Local schema, source-hash, selector and split checks; performs no search |
| `validation.praxis.json` | Saved validation result and corpus checksum |
| `self-review.md` | Five author self-reviews performed before measurement |
| `prepare_snapshot.py`, `transport/Program.cs` | Verified private backup and direct access to the unchanged production query engine |
| `run_benchmark.py` | Three-mode collection with randomized mode order, raw envelopes and family bootstrap scoring |
| `run-20261019.md` | Measured baseline, evidence locations and remaining limits |
| `semantic-acceptance.praxis.json` | Frozen 40-question, 20-family acceptance set, consumed only after candidate selection |
| `path-corpus.praxis.json`, `evaluate_paths.py` | 12 measured static code-path scenarios, with entry and complete-path scores separate |
| `evaluate_semantic.py`, `semantic_experiments.py` | Production-engine vector replay and five initial development experiments |
| `semantic-improvement-20261019.md` | Integrated improvements, fresh acceptance and code-path results |

The retrieval corpus covers 48 behaviours in 24 source files across these areas:

| Area | Behaviours | Split |
| --- | --- | --- |
| Workflow editor | Node edits, connecting stages, cycle detection, layout | Development |
| Workflow storage | Definition precedence, permanent saves, draft replacement and removal | Development |
| Connections | Backend dispatch, unavailable backends, board synthesis and repository identity | Held out |
| Workspaces | Register/remove external documents, tolerate unreadable files, preserve project prose | Held out |
| Git | Preflight, selected-path commits, hunk actions, symlink containment | Held out |
| Chat | Turn tool attribution, tool identity, message grouping, cumulative reasoning | Development |
| Gadgets | Host scope, operation routing, lifecycle, hiding protocol JSON | Held out |
| Code intelligence attachment | Project overrides, model activation, owner replacement, cached fingerprints | Development |
| Embedding model | Installed versus active, status, downloads, asset verification | Held out |
| Appearance | Pattern normalization, pack inheritance, CSS layers, phone theme publication | Held out |
| Providers | Eligibility, replacement ordering, reviewer independence, isolated budget failures | Held out |
| Mobile host | Pending permissions, ordered decisions, image sandbox/chunking, session projection | Held out |

Each positive family has three queries: an exact identifier control, a terminology query using different wording, and a behaviour question requiring explanation of a condition or edge case. There are **144 positive queries and 24 contradicted-premise queries**. The latter have explicit counter-evidence and expected corrections. They do not require the retrieval engine to return an empty list: finding code that disproves a premise is useful.

Development: 56 queries, 16 positive families, four agent tasks. Held out: 112 queries, 32 positive families, eight agent tasks. Related variants, supporting labels, negative premises and agent tasks stay in the same split. No source file appears in both splits. Previously exposed workflow, chat and attachment topics are development only.

The held-out split is unused for ranking experiments during this authoring turn. It is **not author-blind**: the author read the implementations to write labels. Domain-based splitting is deliberately conservative about earlier exposure, but means this held-out score cannot estimate workflow or chat quality. Report domains separately. If future acceptance must cover those domains, obtain fresh independently authored cases before tuning.

## Ground truth and fair scoring

All 48 exact selectors were resolved to one symbol with `find_symbol`; `get_source` confirmed matching indexed/current source hashes. Every primary label is in a complete compiler context. The entire index was globally partial because it also included a syntax-only fallback context. That context's results must remain eligible when comparing modes. No test-file or synthetic-file exclusion was applied to make the labels easier to retrieve.

The source revision is `b758fa2472b4bda042be0bed1142ea081655c26d`, **plus existing working-tree changes**. Per-file SHA-256 values identify the actual labelled source, including those changes. A clean checkout of that commit alone is not a reproduction. The evidence records index generation 79, query epoch 169 and the active model fingerprint.

The `expected` arrays are **primary implementation anchors**, suitable for the existing evaluator's strict lookup score. They are seed relevance labels, not an exhaustive list of good answers. Supporting caller/callee labels are recorded separately in `judgments`:

- 3: direct implementation.
- 2: an independently sufficient alternative, added only after review.
- 1: useful supporting context, insufficient alone.
- 0: reviewed irrelevant result.
- Unlisted: unjudged, rather than automatically wrong.

Before publishing a definitive relevance comparison, pool the union of top-20 results from lexical, vector and hybrid, deduplicate identities, hide the mode and rank, and review relevance against the frozen query and answer points. An e2e test that fully explains a behaviour can receive grade 2; a whole-file placeholder does not receive relevance solely because it contains a matching word. Log every judgment and source citation. Review labels without seeing which mode benefits. Retain both the original anchor score and pooled score; never silently relabel misses. Review a sample independently and record disagreements. Keep all review declarations false until that work is done.

Report these measurements on held-out cases only:

- Hit@1/3/5/10 and MRR@10: whether a grade 2 or 3 answer is found, and its first rank.
- Recall@10: fraction of distinct grade 2 or 3 relevant identities retrieved. With the initial single anchor this equals Hit@10; do not confuse it with complete behavioural coverage.
- nDCG@10 after pooling: gain `2^grade - 1`, discounted by `log2(rank + 1)`, normalized by the ideal ordering of judged relevant identities. Mark remaining unjudged top-10 results and do not present incomplete pooling as final.
- Exact controls separately from terminology and behaviour queries; exact names must not inflate the headline semantic score.
- Category and domain scores, tool errors, duplicate results, vector fallback, source-evidence failures, candidate/result truncation and p50/p95 latency.
- Paired hybrid-minus-lexical and vector-minus-lexical differences on the same queries. Average variants within a family first; bootstrap **families**, not individual paraphrases, with a fixed seed and 10,000 resamples for 95% intervals. Report the 32 held-out families as the sample size.
- For false premises, score the agent's correction and citation. Empty search results alone are neither success nor failure.

Thirty-two held-out behaviours provide broader diagnostics than the earlier pilot. They cannot guarantee a narrow confidence interval for a small gain. Use the observed interval to decide whether more independent families are needed; repeated paraphrases do not supply them.

## Running retrieval

From the desktop directory, first validate without touching held-out rankings:

```sh
python3 -B docs/evaluations/code-intelligence/validate.py
```

The corpus is version-1 compatible with the existing native evaluator. Against an already provisioned isolated desktop-root index:

```sh
python3 ../../services/code-intelligence/scripts/evaluate-retrieval.py \
  --executable /absolute/path/to/Praxis.CodeIntelligence \
  --data /absolute/private/evaluation-data \
  --repository REPOSITORY_ID \
  --corpus docs/evaluations/code-intelligence/retrieval-corpus.praxis.json \
  --output /absolute/private/desktop-retrieval-results.praxis.json
```

The existing evaluator runs lexical, hybrid and vector when a model is active, resolves selectors before searching, and writes individual results. It also evaluates its fixed release gates. **An exit status of 2 is expected for this diagnostic corpus**: its 56/112 split is not the release protocol's 40/80 split; it does not claim 20 cross-project and 20 stale cases or completed human review. Inspect the actual failing gates, not just the exit code. Missing selectors or tool errors are real failures and must be investigated. The evaluator's current report supplies anchor recall/MRR, not pooled nDCG or the clustered intervals above.

Freeze the service executable hash, model fingerprint, corpus hash, full source snapshot, captured compiler manifests, ranking profile and query arguments before baseline collection. Copy the actual working-tree source into a disposable fixture; include uncommitted source and verify the recorded hashes. Keep corpus files, rubrics, result logs and benchmark docs **outside the registered fixture** so answers cannot leak into its knowledge index. No build, test, index lifecycle scenario or agent may write into the working checkout.

Wait for stable generation/epoch and complete current model coverage. Record all contexts, including intentional fallback contexts. Compare the same source manifest and filters across modes. Do not drop hard cases, narrow scope only for one mode, change models, or change top-k between runs. Invalid coverage or a changing snapshot invalidates the run, not the question. Keep the repository's stricter complete-compiler-context release requirement distinct from this desktop diagnostic.

The new `run_benchmark.py` collects all three modes with randomized mode order per query, records seed 20261019, warms the engine before collection, and retains raw top-20 responses with paging when required by the response budget. It invokes the production query engine directly on the frozen backup; it does not measure CLI/owner/UI transport. The older native evaluator above uses a fixed order. Keep the two latency measurements distinct. Run both baseline and candidate against identical fixtures. Use development cases only to select a candidate; evaluate the held-out split once after selection. The recorded baseline has now exposed this held-out set: any hypotheses or tuning informed by its scores need fresh acceptance data.

The actual baseline used these commands (choose a new destination/output for another run; both scripts refuse to overwrite a prior run):

```sh
python3 -B docs/evaluations/code-intelligence/prepare_snapshot.py \
  --source . \
  --live-data '/Users/daveacres/Library/Application Support/Praxis/code-intelligence' \
  --build ../../services/code-intelligence/src/Praxis.CodeIntelligence/bin/Debug/net10.0 \
  --destination /private/tmp/pci-bench-20261019

python3 -B docs/evaluations/code-intelligence/run_benchmark.py --self-check

python3 -B docs/evaluations/code-intelligence/run_benchmark.py \
  --snapshot /private/tmp/pci-bench-20261019/snapshot.praxis.json \
  --output .praxis/session-artifacts/code-intelligence-benchmark/run-20261019
```

## Agent comparison

Run `agent-cases.praxis.json` as separate fresh sessions. Do not show agents the corpus, answer checklist, evidence selectors or other agents' answers. Give all arms the same user prompt, frozen source, model/version, system instructions except tool availability, permissions, context budget, token limit and time limit. No preloaded source findings. Counterbalance arm order using a recorded seed, repeat each task three times, and record actual tool calls rather than assuming availability means use.

The four arms are files/text search only, code intelligence with lexical retrieval, code intelligence with vector retrieval, and code intelligence with hybrid retrieval. The three code-intelligence arms retain identical structural tools; enforce `search_code.mode` in the harness. File tools remain available to all arms. Disable knowledge search for these code-analysis tasks so it cannot bypass the selected retrieval mode. Treat mode violations as invalid runs. The files-only versus hybrid comparison measures overall tool benefit; the lexical versus vector/hybrid comparisons isolate retrieval changes more closely.

The rubric totals 10: correctness 0–4, supported source citations 0–2, required behaviour coverage 0–2, and appropriate uncertainty 0–2. Correctness: 4 for a correct causal explanation, 3 for a minor error, 2 for a material omission, 1 for a mostly incorrect explanation, 0 for no usable answer. For each other dimension: 2 for complete, 1 for partial, 0 for absent or misleading. Score the listed checklist and critical trap. Fabricated functions, fabricated runtime proof or a reversed authority boundary are critical errors; report their rate separately and do not hide them in an average.

Strip arm metadata, randomize answer labels and have an independent reviewer score answers before revealing the arm. Retain citations, a claim-by-claim judgment, time, tokens, cost, tool calls, files read and reviewer disagreements. Pair scores within task and repetition, then average repetitions per task; confidence intervals resample tasks, not repetitions. The eight held-out agent tasks are a pilot of agent usefulness, not a precise population estimate.

Predeclare a practical decision rule before running: a candidate must preserve exact-control accuracy, avoid a domain recall drop greater than five percentage points, and demonstrate a positive natural-language retrieval gain whose paired 95% interval excludes zero. For overall agent benefit, target at least one point on the 10-point rubric with an interval excluding zero and no increase in critical-error rate. If intervals are too wide, call the result inconclusive and expand independent tasks. These are proposed decision criteria for this suite, not existing release gates or measured outcomes.

## Scope limits

This is a broad **desktop TypeScript** suite. It does not claim native C# relevance, shared-core status mapping, Flutter coverage, documentation search quality, controlled stale transitions, source lifecycle execution, or whole-product release acceptance. The separate lifecycle cases specify additional controlled checks; they have not been executed or folded into recall. Existing Maze/native and TypeScript evaluation artifacts remain separate evidence. To establish general benefit across languages and repositories, freeze further independently reviewed corpora on those roots and report them separately rather than padding this desktop denominator with out-of-scope answers.
