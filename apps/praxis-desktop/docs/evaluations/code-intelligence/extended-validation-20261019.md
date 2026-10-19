# Broader semantic validation

19 October 2026. This follow-up evaluates the already-selected implementation. **No application ranking changes are selected from these results.** Independent human review is still pending; preparation of a blinded packet is not completion of that review.

## Frozen scope

- Maze: existing 120-query C# corpus, including 80 previously exposed acceptance cases. Its 225-file captured fixture retains four complete compiler contexts and the earlier controlled renames. Every indexed file matches its recorded hash. The new replay reads the resulting state; it does not rerun the original rename transitions or execute Maze targets.
- Praxis TypeScript: existing 48-query pilot across shared core, mobile protocol and desktop sources. A private fixture copies all 626 production `.ts`/`.tsx` files from these areas, excluding tests uniformly for both engines. All 40 positive selectors resolve uniquely, including shared-core labels outside the earlier desktop-root snapshot. This fixture has a partial context because dependencies are not installed into the copy. Its uniform diagnostic tsconfig is recorded. This comparison cannot reproduce historical pilot percentages exactly or claim complete compiler acceptance.
- markdown-it JavaScript: 20 new natural-language behaviour questions over a separately copied installed project, 271 symbols. Questions and source hashes were frozen before the first search, SHA-256 `a03ce94a6fe204104b54fbc1deed91fe410288a4f9c5d2bd472e1a5b50b032d7`. The installed source tree, not an assumed pristine upstream release, defines the fixture. Context is partial because external dependencies are not copied. This is a small, AI-authored generalization diagnostic, not an independently reviewed benchmark.

All arms use the pinned bge-small model and the same source facts per fixture. The baseline is the previous production engine; the candidate is the source implementation from the earlier improvement run. Direct ModelStore activation updates only private derivative vectors. No app owner, active app index, repository source, model weights, benchmark prompts or relevance labels are changed by measurement.

## Retrieval results

### Separate C# project: Maze

The replay reproduces the previous hybrid baseline exactly. All **360 case/mode rankings** are identical between baseline and candidate; 720 comparisons total.

| Held-out positive set / mode | Before | After |
| --- | ---: | ---: |
| Natural-language only, semantic | 26/41 (63.4%), MRR 0.329 | 26/41 (63.4%), MRR 0.329 |
| All 66 labelled cases, semantic | 77.3%, MRR 0.538 | 77.3%, MRR 0.538 |
| All 66 labelled cases, hybrid | 92.4%, MRR 0.734 | 92.4%, MRR 0.734 |
| All 66 labelled cases, lexical | 89.4%, MRR 0.672 | 89.4%, MRR 0.672 |

Natural-language scoring excludes exact-name and stale-name controls. The C# representation and single-query behaviour are unchanged, so unchanged results are non-regression evidence, not a new C# embedding advantage. All returned source evidence and coverage checks pass; databases remain unchanged during replay. Existing corpus declarations are inherited from prior AI review and must not be interpreted as a new independent human review.

### Broader Praxis TypeScript pilot

| Mode | All-positive macro Recall@10 before / after | Natural-language Hit@10 before / after | Natural-language MRR before / after |
| --- | ---: | ---: | ---: |
| Lexical | 78.8% / 78.8% | 23/30 / 23/30 | 0.625 / 0.625 |
| Semantic | **85.0% / 93.8%** | **26/30 / 29/30 (86.7% / 96.7%)** | **0.577 / 0.785** |
| Hybrid | 81.3% / 87.5% | 24/30 / 27/30 | 0.675 / 0.672 |

There are 40 positive cases, including ten exact controls, and eight negative cases; all 48 run in all three modes for both engines (288 comparisons). Several cross-project questions label multiple required symbols. Macro recall measures their fraction retrieved; Hit@10 means at least one label was found. Neither is complete graph-path discovery. The natural-language rows exclude exact controls. Hybrid gains coverage but loses a little MRR; retain both results. The copied context is partial, so these are diagnostic results on fixed current source, not complete-compiler release acceptance.

### Separate JavaScript project: markdown-it

| Mode | Before Hit@10 | After Hit@10 | Before MRR@10 | After MRR@10 |
| --- | ---: | ---: | ---: | ---: |
| Lexical | 3/20 (15%) | 3/20 (15%) | 0.045 | 0.045 |
| Semantic | 11/20 (55%) | 11/20 (55%) | 0.255 | 0.297 |
| Hybrid | 6/20 (30%) | 5/20 (25%) | 0.145 | 0.079 |

Semantic rescues three targets and loses three others; the unchanged hit rate conceals that trade. Hybrid loses the heading-recognition target. No cases were removed or rewritten after seeing these results. One authored query (`markdown-js-08`) says “slash” where “backslash” would be more precise; retain the frozen wording and denominator, and flag it for independent relevance review. Both semantic arms find its expected target.

All 120 comparisons have stable snapshots, complete current vector coverage, source evidence, no tool errors and no duplicate results. The small corpus and partial compiler context do not pass the separate release protocol. These results do not support a broad claim that the original 87.5% desktop accuracy generalizes to JavaScript projects.

## Scope bug discovered and corrected

Activating the first candidate on Maze exposed two synthetic C# entry symbols whose qualified names contain source paths. The original slash-name heuristic gave them semantic headers and enabled query expansion for the C# repository. Initial query-only replay with old vectors had concealed that activation path.

The corrected builder uses the indexed project/context language, not a slash heuristic. Unknown languages receive no header. Representation format **5** forces refresh from formats 2 and 4. A new native integration regression uses a nested C# `Program.cs` and verifies activation keeps a single query view. Unit coverage also checks root-level JavaScript eligibility and C# path exclusions. The format-upgrade theory checks both old versions.

After correction and activation, Maze has **zero semantic headers** and all 360 rankings match baseline exactly. JavaScript results remain unchanged. The original desktop acceptance result remains **35/40**, with identical result lists for all 40 questions; all-development remains **67/96** and the original comparison **46/64**. Path scores remain 11/12 entry hits, 12/12 oracle traces and 8/12 complete discoveries from three seeds. The failed intermediate activation replay is retained in `extended-maze-upgraded-candidate/`.

**Verification:** the full configured native suite passes **200/200**, no skips/failures (`language-scope-tests.trx`); actual shared-source build passes into private output. Seven evaluation-helper tests pass. Hash-guarded source promotion preserves unrelated WIP. The model weights, manifest and query-ranking weights are unchanged. This is a language-scope correction, not a ranking candidate selected using the new JavaScript questions.

## Sequential latency measurement

`latency-plan.praxis.json` fixes 24 natural-language questions: the terminology and behaviour variants of the first family by ID in each of the 12 original desktop domains. Three repetitions yield 72 timed calls per arm. Arm and question order are counterbalanced using seed 20261020. Warmup is excluded. Both engines stay resident, with only one active request at a time; collection starts after embedding provisioning and relevance runs finish.

The measurement includes any response-budget pages needed to obtain the first ten slots, using the same 8,000-token budget. It excludes owner/UI transport and is not the 50,000-symbol capacity qualification. The candidate retains the pre-existing inference-thread WIP from the checkout, so timings compare whole frozen builds and cannot isolate the cost of representation or query expansion alone.

### Measured final-build latency

| Warm first-ten request | Baseline | Candidate |
| --- | ---: | ---: |
| Median | 104 ms | 766 ms |
| 95th percentile | 120 ms | 1403 ms |
| Mean | 112 ms | 909 ms |

The candidate is **7.3× slower at the median** on this workload. All 144 timed requests have full vector coverage, no errors, stable snapshot numbers and identical within-arm rankings across repetitions. This is a material trade-off and is not a performance acceptance pass. The earlier selected build was timed separately and retained as a diagnostic; this table uses the language-corrected final build. Engine metadata, the fixed query plan and raw timed envelopes are preserved. No embedding builds or other evaluation queries ran alongside the final timing collection.

## Independent relevance review

The packet is at `.praxis/session-artifacts/code-intelligence-benchmark/independent-review/README.md`:

- 40 original fresh acceptance questions, randomized and renamed.
- Union of the paired semantic top tens: **641 question-result pairs, 470 distinct symbols**, with matching source excerpts and 174 copied source files.
- No visible engine identity, original rank or expected-anchor labels in question pages.
- Blank `judgments.praxis.jsonl`; reviewer identity, grade, rationale and source citation are required for every result. Unresolved context requests must be resolved from the copied source.
- `review-key.praxis.json` is withheld until ratings are frozen. `score_blinded_review.py` validates and hashes ratings before opening the key, and does not infer reviewer independence from a filled form.

The pool covers semantic before/after top tens only. It is not a full lexical/hybrid top-20 relevance pool or an agent-answer evaluation. A reviewer who authored or tuned the benchmark must declare that conflict; another pass by this author is not independent review. Seven focused scorer tests pass, including rejection of blank, duplicated, incomplete, uncited and unresolved-context ratings. All 641 real ratings remain unjudged.

## Evidence and reproduction

Evidence root: `.praxis/session-artifacts/code-intelligence-benchmark/`:

- `extended-maze-baseline/`, `extended-maze-language-candidate/` (final); earlier intermediate replays retained separately.
- `extended-javascript-baseline/`, `extended-javascript-language-candidate/` (final).
- `extended-typescript-baseline/`, `extended-typescript-candidate/`.
- `sequential-semantic-latency-final/` (final build); earlier timing also retained.
- `independent-review/`.

Each replay preserves raw production envelopes and source preflight. `evaluate_corpus_snapshot.py` wraps the project's existing native evaluator; it records current source checks, pagination, immutable database bytes, engine identity and the corpus hash. Existing release gates remain visible even where the diagnostic corpus cannot meet them. They do not substitute for human review.

`fixture-transport.cs` provides explicit index/model setup for disposable fixtures and normal production QueryService calls. Never direct provisioning at the live owner database. `prepare_blinded_review.py`, `score_blinded_review.py` and `compare_semantic_latency.py` provide the review and timing procedures. Question/label JSON remains unchanged after measurement. Model assets can be provisioned from the previously verified pinned local bundle; no Maze application code or project targets need to run.

No UI changed and no visual verification was performed. Application service source has the explicit language-scope correction described above; the running app and its owner index remain unchanged. Independent review, agent-answer comparisons, complete compiler acceptance for the copied JS/TS fixtures and release-scale performance qualification remain separate work.

## Handoff

Automated broader validation is complete. The final three cohorts contain 1,128 case/mode comparisons, excluding intermediate replays and the separate timing run. The improvement is substantial on the broader Praxis TypeScript pilot, unchanged in C# retrieval, and mixed on the separate JavaScript project. These results support a scoped TypeScript improvement, not a general accuracy percentage across repositories. Hybrid's JavaScript regression and the measured latency cost remain unresolved. No application reload, owner-index rebuild, commit or publication was performed.

Human relevance review is **not complete**: the packet is prepared and all 641 ratings are still blank. A reviewer must be named and supply those judgments before an independent-review claim can be made. Model/agent answer quality remains unmeasured.
