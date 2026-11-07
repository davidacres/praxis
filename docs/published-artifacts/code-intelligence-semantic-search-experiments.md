# Praxis code intelligence: semantic search experiments and results

Oct 20, 2026 · @david acres

## Summary

Agents in Praxis now get the best measured code search by default, and the chat shows when they used it. Plain-language questions about TypeScript or JavaScript go to semantic search; names, short phrases and C# go to hybrid search. On every evaluated set this finds as many or more expected answers than the old hybrid-only default, at about 0.3 s per question search instead of 0.1 s.

| Test set | Old default (hybrid) | New default (routed) |
| --- | --: | --: |
| Desktop TypeScript, 96 labelled questions | 75 | **78** |
| Shared-core TypeScript pilot, 40 | 37 | **39** |
| markdown-it JavaScript, 20 | 6 | **11** |
| Maze C#, 66 held-out | 63 | 63 |

Counts are questions whose expected symbol appears in the top 10 results. All labels were written by the AI evaluator and have not been independently reviewed. These are retrieval scores, not measures of agent answer quality.

The work started from a simple observation: code intelligence never appeared to be used. Two separate problems caused that. The chat badge failed to recognise real code intelligence calls, and agents were not told when the index was the better tool.

## Chat badge: making code intelligence use visible

Real code intelligence calls showed no badge because the detector missed three naming shapes. All three are fixed and covered by e2e tests.

| Cause | Fix |
| --- | --- |
| ACP recorded the display title ("Search code") instead of the namespaced tool name | Prefer the stable `name` over `title` |
| Some ACP adapters report a call already completed, with no start event | Count completion-only calls in the turn |
| The detector did not accept `mcp.code_intelligence.search_code` | Accept every host's naming form |

The badge now reads **code intel** without a count and opens the Activity tab. Separately, agents now get a short routing prompt when the index is attached. It sends structure, call-path and concept questions to code intelligence, and exact strings to text search. Each MCP tool description also says what the tool is for.

## Early pilots: workflow questions

In the early pilots, hybrid search beat keyword-only and semantic-only, but the samples were small and the semantic scores were disappointing.

| Pilot | Lexical | Semantic only | Hybrid |
| --- | --: | --: | --: |
| 7 scored workflow questions | 6/7, MRR 0.536 | 5/7, MRR 0.429 | **7/7, MRR 0.645** |
| 30 workflow questions | 12/30, MRR 0.344 | 12/30, MRR 0.237 | **15/30, MRR 0.373** |

An earlier 4-question run was directional only: hybrid ranked the workflow-definition lookup higher on two questions, and every mode missed status mapping. The 30-question pilot also showed the evaluation itself needed work. Labels expected one production symbol, while semantic search often returned reasonable test-file matches. That led to a proper benchmark with a held-out split.

## The 168-query benchmark

On the held-out natural-language questions, semantic search found the most answers (40/64) and hybrid ranked them highest (MRR 0.428). The benchmark covers 48 desktop behaviours across 12 areas, each asked three ways: exact name, terminology and behaviour. It adds 24 questions with false premises, 12 agent analysis tasks and 6 lifecycle scenarios.

| Mode | Held-out NL answers in top 10 | MRR@10 |
| --- | --: | --: |
| Lexical | 33/64 (51.6%) | 0.310 |
| Semantic only | **40/64 (62.5%)** | 0.373 |
| Hybrid | 39/64 (60.9%) | **0.428** |

- **Splits:** related questions stay in one family, so paraphrases cannot leak from tuning into the 112 held-out queries.
- **Review:** five self-review passes before the run fixed a missing native library and snapshot drift.
- **Integrity:** all 504 mode comparisons ran on a frozen private snapshot, with no tool errors or duplicates.

## Semantic improvement rounds

Semantic-only search on 40 untouched acceptance questions rose from 23/40 (57.5%) to **35/40 (87.5%)**, with no previously found answer lost. The pinned bge-small model is unchanged; the gain comes from what gets embedded and how the question is asked.

| Attempt | Result | Kept? |
| --- | --- | --- |
| Five query-only variants (old vectors) | Best stayed at 40/64 | No |
| Readable names in the representation | 40/64 → 38/64 | No |
| Semantic header vector (name, signature, docs, callees) + source vectors, scored together | Part of the winning candidate | Yes |
| Query views: a few rephrasings of the question, fused | 46/64 (71.9%) on the development comparison | Yes |
| Language check by indexed language, not name shape | Stopped C# picking up headers | Yes |

Two bug fixes came out of this work. A trace that exceeded its response budget dropped local helpers before external endpoints. Trimming one node at a time, externals first, raised correct-entry path tracing from 9/12 to 12/12 complete. A vector-reuse check also avoided needless re-embedding.

| Path discovery (12 cases) | Before | After |
| --- | --: | --: |
| Entry point found by search | — | 11/12 |
| Complete path from the correct entry | 9/12 | 12/12 |
| Complete path from search results alone | 3/12 | 8/12 |

Across all 96 development questions semantic-only reached 69.8%, just under the 70% target; the target was met on the original 64 (71.9%) and the fresh acceptance set (87.5%).

## Extended validation

The gain held on a broader TypeScript set but not beyond TypeScript: C# and JavaScript semantic scores were unchanged, and at this stage search was 7.3× slower.

| Set (semantic only, NL Hit@10) | Before | After |
| --- | --: | --: |
| Broader Praxis TypeScript (626 files, 28,262 symbols) | 26/30 | **29/30** |
| Maze C# (separate project) | 26/41 | 26/41 |
| markdown-it JavaScript (20 new questions) | 11/20 | 11/20 |

- **Regression found:** JavaScript hybrid fell from 6/20 to 5/20 (fixed later by the two-slot floor).
- **Bug found:** two C# entries with slash-containing names were treated as TypeScript; fixed by using the indexed language.
- **Cost at this stage:** median search time rose from 104 ms to 766 ms (Debug build).
- **Review packet:** a blinded packet of 40 questions and 641 results was prepared for independent rating; it is still unscored.

## Speed work

Semantic searches now return in about 270–295 ms median in the Release build, within the agreed half-second budget. The slowdown came from scanning vectors once per query view; embedding the question took only about 13 ms.

| Desktop TypeScript semantic search | Median | p95 |
| --- | --: | --: |
| Original engine (Debug) | 104 ms | 120 ms |
| Improved, before optimisation (Debug) | 766 ms | 1,403 ms |
| With shared vector scan (Debug) | 435 ms | 609 ms |
| With shared vector scan (**Release**, as packaged) | **269 ms** | **308 ms** |

- **Shared scan:** each stored vector is read, validated and decoded once and scored against every query view. Rankings stayed identical across 1,108 comparisons.
- **SQL rewrite:** checking embedding completeness per set was slightly slower, so it was rejected.
- **Other fixtures (Release):** broader TypeScript 294 ms median; markdown-it JavaScript 29 ms. All 372 warm requests finished under 500 ms; a cold first request with model loading took about 650–700 ms.

## Hybrid fixes and routing

Hybrid weights keyword matches 4:1, which buries good semantic matches on TypeScript and JavaScript but suits C#. Rather than one compromise weight, the default now picks the better mode per question.

**1. Vector floor 1 → 2 (kept).** Hybrid guaranteed only the single best semantic result a top-10 place. A one-place swap in the semantic ranking dropped markdown-it's heading answer entirely. Guaranteeing two places fixed it without losing a hit anywhere: JavaScript 5 → 6/20, Maze C# held-out 61 → 63/66, desktop held-out 42 → 43/64, TypeScript pilot unchanged at 37/40.

**2. Fusion experiment 4 (rejected).** Pre-registered grid: query views on or off in hybrid × keyword weight 1, 2 or 4. The TypeScript tuning set picked weight 1, but it failed the C# guard.

| Hybrid configuration | Maze C# held-out (guard) | TypeScript pilot (guard) | markdown-it (report only) |
| --- | --- | --- | --- |
| Weight 4, single view (kept) | **R@10 0.955, MRR 0.738** | R@10 0.875, MRR 0.754 | R@10 0.300, MRR 0.084 |
| Weight 1, single view (selected) | R@10 0.939, MRR 0.668 | R@10 0.887, MRR 0.797 | R@10 0.300, MRR 0.177 |

Query views in hybrid made almost no difference, so they stay semantic-only.

**3. Unset-mode routing (shipped).** When an agent leaves `mode` unset, a question of three or more words goes to semantic search if the index has TypeScript/JavaScript semantic headers; anything else goes to hybrid. An explicit mode always wins. Replayed on saved results, routing matched or beat both modes on every set (see the Summary table). The three-word cut-off was chosen after seeing these results, so it is not a blind test.

## Final state and open items

All changes are merged into local `main` (10 commits ahead of origin, not pushed). The code intelligence service suite passes 202/202 with none skipped; the badge, usage and prompt tests pass.

| Commit | Change |
| --- | --- |
| `2cfed84a` | Unset search mode routes to the best measured search |
| `c4b3b464` | Fusion experiment 4 recorded as rejected |
| `2c75e830` | Benchmark corpora, scripts and reports |
| `7d079607` | Usage panel two-row limit chart (separate earlier work) |
| `8ee31b86` | Chat "code intel" badge detection fixes |
| `864273c4` | Agents told when to use code intelligence |
| `07d35d65` | Hybrid keeps the two best semantic results on page one |
| `872a5589` | Semantic headers, query views, shared vector scan |
| `bac3ea1d` | Trace budget keeps local helpers |
| `546d1e8b` | One inference thread per performance core |

Open items:

- [ ] Restart Praxis via `scripts/run-app.sh`; the first launch re-embeds the index for several minutes
- [ ] Spot-check real questions for the badge and correct files; revert `2cfed84a` alone if routing looks wrong
- [ ] Independent review of the blinded packet (641 unscored ratings)
- [ ] End-to-end agent answer-quality comparison, not yet run
- [ ] Optional: a language-aware hybrid weight (1 for TS/JS, 4 for C#) as its own experiment
- [ ] Fusion experiment 4's 168-query desktop set was still collecting at writing; report-only

## Reports in the repo

Every experiment has a markdown write-up under `apps/praxis-desktop/docs/evaluations/code-intelligence/` unless noted. Raw responses and snapshots live in the git-ignored `.praxis/session-artifacts/code-intelligence-benchmark/`, so they exist only in the local checkout.

| Report | Covers |
| --- | --- |
| `SUMMARY-20261020.md` | Index of everything below, plus the early 4- and 7-question pilots |
| `../../code-intelligence-workflow-search-pilot.md` | 30-question workflow pilot with per-question ranks |
| `README.md` | Benchmark design, splits and how to rerun |
| `self-review.md` | Five self-review passes before the first run |
| `run-20261019.md` | Baseline 504-comparison run |
| `semantic-experiment-plan.md` | Pre-registered plan for the improvement rounds |
| `semantic-improvement-20261019.md` | Representation, headers, query views, path discovery, acceptance |
| `extended-validation-20261019.md` | Broader TypeScript, Maze C#, markdown-it, first latency run |
| `shared-scan-20261019.md` | Shared vector scan and timing breakdown |
| `release-timing-20261019.md` | Release vs Debug timing per language |
| `hybrid-floor2-20261020.md` | Two-slot vector floor |
| `fusion-experiment-4-20261020.md` | Rejected weight/views experiment |
| `search-mode-routing-20261020.md` | Unset-mode routing and its replayed scores |
