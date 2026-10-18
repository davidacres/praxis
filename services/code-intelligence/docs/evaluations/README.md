# Maze evaluation preparation

The user supplied `https://github.com/davidacres/maze`. These drafts use a separate clone pinned to `61d4510a8ef6946407fa310038ae0add1fffdf24` (546 C# files and 21 project files in the checkout). Maze source was read, not changed. No Maze project evaluation, build, restore, generator or application was executed.

`maze-tuning-draft.praxis.json` contains **40 unreviewed tuning queries**, grounded in the actual implementations of refresh-token handling, provider health and dynamic collection matching. The exact qualified selectors were resolved against the native source-only index. These are seed tuning labels, not a frozen 120-query corpus or held-out data. All human review declarations remain false.

`maze-source-only-draft-results.praxis.json` records actual CLI/owner calls against that disposable index: 80 searches, no tool errors or duplicate results, valid source evidence for returned relevant symbols, and unchanged generation/query epoch across the final run. Hybrid explicitly fell back to lexical because no model was activated in this data directory. The context is `syntaxOnly`, so complete compiler coverage fails. No held-out metrics are computed from these tuning cases. Earlier attempts overlapped startup reconciliation and were rejected by the stable-snapshot check; the retained run waited for startup debounce and queued work to settle.

Remaining preparation: independently prepare/freeze 80 held-out queries with at least 20 total per required category and held-out representation of every category, review labels and split leakage, capture trusted compiler contexts, install/activate the pinned model and verify complete current coverage, then rerun. Cross-project and stale-transition scenarios require their own concrete setup/evidence. Human abstention and 30 explanation reviews remain required; declarations cannot substitute for that work. The full feature is not complete.

The separate native CI run [38818829365](https://github.com/davidacres/praxis/actions/runs/38818829365) checks the evaluator and service at `855aba2099a5ed179f14faa99a99e5c89b73c50b`; consult its result rather than assuming a green result for later revisions.

## Real local model tuning run — 16 October

`maze-model-tuning-results.praxis.json` records the same 40 unreviewed tuning queries through the current packaged native owner, with the pinned MiniLM profile activated. All 14,298 eligible source symbols have current vectors. All 80 searches completed without errors or duplicate results; returned relevant symbols have expected source evidence, and generation/query epoch stayed fixed. Every hybrid response reports full vector coverage.

Among the 35 positive tuning cases, macro Recall@10 is **0.80 hybrid** and **0.4571428571 lexical**. Five negative cases do not earn recall. These figures are calculated from the per-case tuning results, not the report's held-out aggregates (which correctly remain empty). They are preliminary tuning observations, not held-out acceptance. Compiler context remains syntax-only, and human labels, split leakage, abstention and explanation reviews remain undeclared. No Maze project targets or application were executed; local embedding inference is performed by Praxis.

## Compiler-backed multi-project subset

`maze-compiler-preparation.praxis.json` and `maze-compiler-context-status.praxis.json` preserve actual preparation at the same Maze commit using its pinned SDK **10.0.100**. Public NuGet restore and an explicit SearchCore build with `EmitCompilerGeneratedFiles=true` succeeded (563 warnings, zero errors). Captured global usings and emitted regex-generator output are semantic support. No tracked Maze source files changed; no Maze applications were started.

The scope is SearchCore, UserService, Maze.Common and Maze.ModuleContracts. Tests, unrelated hosts/modules, installer and the `.github` test template are excluded explicitly. All **four contexts are complete** after adding the six generated support files. The observed compiler graph has **76 resolved cross-project call edges**, plus separately counted references/type/dependency/import/access facts and **11 possible** calls. This is actual context/graph preparation, not a whole-Maze or held-out relevance pass. The earlier 40-query model report remains source-only evidence and is not retroactively upgraded by this preparation.

The evaluator now trusts the service's repository-wide `freshness.state=current` completeness calculation while checking every returned context. Truncating warning diagnostics no longer falsely fails compiler completeness; a globally partial repository still fails even if all visible contexts look complete. The native SDK fixture also verifies actual generated implicit usings and `Task`/`DateTime` resolution. Local checks: 97 C# tests, 109 response schemas and 11 evaluator tests including the packaged owner.

## Compiler-backed model tuning pilot

`maze-compiler-tuning-draft.praxis.json` preserves the same 40 tuning texts with selectors mapped by original declaration owner/name to their compiler-qualified identities. `maze-compiler-model-tuning-results.praxis.json` records actual packaged-owner queries with all four complete compiler contexts, full current semantic vector coverage, stable generation/epoch and no tool errors/duplicates; relevant returned symbols have expected source evidence. Review declarations remain false.

The 35 positive tuning cases measured macro Recall@10 **0.7714285714 hybrid** versus **0.5142857143 lexical**. Eight hybrid misses are retained rather than relabelled. These are tuning observations only; the 120-query stratified reviewed corpus/held-out evaluation and negative/explanation reviews remain work. The earlier source-only and current compiler-backed runs differ in scope/identity representation and are not a controlled estimate of the compiler's effect on quality.

## Versioned 120-query acceptance corpus

`maze-release-corpus.praxis.json` freezes 40 tuning and 80 acceptance cases, with 20 cases per category, source hashes, AI review attribution, two overloaded-name cases and explicit controlled transitions. `scripts/evaluate-maze-release.py` copies the captured sources/support/project inputs into a new private directory, performs the renames/moves without building or changing the supplied repository, verifies old-source refusal and retired IDs, activates the provided local model, then evaluates. The runner rejects an existing fixture directory. Source clone/SDK capture/model provisioning remain explicit prerequisites.

`maze-release-baseline-results.praxis.json` preserves the failing equal-weight profile. `maze-release-weight4-results.praxis.json` preserves the failing intermediate profile. `maze-fusion-tuning.praxis.json` contains complete channel ranks for only the 40 tuning cases; `maze-fusion-expanded-tuning.praxis.json` records the expanded selection grid and source artifact hash. `maze-release-results.praxis.json` records the current passing profile. Its acceptance Recall@10 and MRR equal lexical-only retrieval; it establishes non-regression and the required recall threshold, not an embedding advantage. The fixed acceptance set has been evaluated repeatedly and is not a fresh blind hold-out. Generated summaries are M5 and not included in the explicit M3 profile.

## Embedding model comparison (2026-10-17)

Three reports rerun the frozen 120-query corpus with the current ranking profile (`rrf-k60-lexical64-vector1-alias0.5-v3`) and only the model changed. `evaluate-retrieval.py` now also scores `mode: "vector"`, so the semantic channel is measured directly rather than only through hybrid fusion. Held-out 80, Recall@10 / MRR@10:

| Mode | `maze-release-model-minilm-results` | `maze-release-model-bge-small-results` | `maze-release-model-bge-small-instruct-results` |
| --- | --- | --- | --- |
| lexical | 0.894 / 0.672 | 0.894 / 0.672 | 0.894 / 0.672 |
| hybrid | 0.894 / 0.672 | 0.894 / 0.672 | 0.894 / 0.672 |
| vector | 0.515 / 0.326 | 0.697 / 0.487 | 0.758 / 0.537 |

Models: `sentence-transformers/all-MiniLM-L6-v2` at the pinned revision; `BAAI/bge-small-en-v1.5` at `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` (model SHA-256 `828e1496…40cf35`, CLS pooling, `vocab.txt` byte-identical to MiniLM's, MIT), without and with the query instruction `Represent this sentence for searching relevant passages: `. The bge runs used a temporary experiment that let `LocalModel` load a second profile; it was never merged and is superseded by the single pinned bge-small profile adopted below, whose own production run reproduces these bge numbers. Every declared gate passed in all three; all four compiler contexts were complete; vector p95 was ~80 ms in each.

Findings: hybrid is unchanged because the 64:1 lexical weight makes the model irrelevant to ranking — a model change alone does not move the shipped default. Vector-only, bge-small with the instruction beat MiniLM on 25 held-out queries and lost 2; terminology rose 0.615 → 0.846, above lexical's 0.615. Any hybrid gain needs fusion retuned with that model on the tuning split only, then the held-out gate. This MiniLM run is the reference baseline for that work: it reproduces `maze-release-configured-dependencies-results` exactly.

Reproducing: build `Maze.SearchCore` and `Maze.UserService` at the corpus revision with `-p:EmitCompilerGeneratedFiles=true -p:CompilerGeneratedFilesOutputPath=obj/scip-generated`; `capture` each (its `--output` must be repository-relative) and merge the two manifests' projects; add each project's `obj/scip-generated/.../RegexGenerator.g.cs` to `supportSources` (six support files in total) or SearchCore and Common resolve `partial` and lexical drops to 0.879. Run `evaluate-maze-release.py` with a short `--fixture` path: the owner's Unix socket lives in the data directory and a long path fails with "Owner directory is too long for a Unix socket."

## bge-small adopted and fusion retuned — search plan 7 (2026-10-17)

bge-small with its query instruction is now the pinned model, and fusion was retuned for it using only the 40 tuning cases:

- `maze-release-bge-small-lexical64-results.praxis.json` — the production bge-small build at the old weight (plan 6). It matches the experimental run above and is the fixture the tuning read.
- `maze-bge-small-fusion-tuning.praxis.json` — the tuning record. The grid (0.25–128) was fixed before collection; the rule is unchanged: tuning Recall@10, then MRR, then lower lexical weight. Weight 16 wins on MRR (every weight ≥ 1 has tuning recall 1.0).
- `maze-release-bge-small-lexical16-results.praxis.json` — acceptance for plan 7 (`rrf-k60-lexical16-vector1-alias0.5-v4`). All gates pass.

Held-out 80, Recall@10 / MRR@10:

| Mode / category | MiniLM, lexical 64 | bge-small, lexical 64 | **bge-small, lexical 16 (shipped)** |
| --- | --- | --- | --- |
| hybrid / all | 0.894 / 0.672 | 0.894 / 0.672 | **0.894 / 0.687** |
| hybrid / behaviour | 0.933 / 0.700 | 0.933 / 0.700 | 0.933 / 0.734 |
| hybrid / crossProject | 0.923 / 0.378 | 0.923 / 0.378 | 0.923 / 0.410 |
| hybrid / terminology | 0.615 / 0.304 | 0.615 / 0.306 | 0.615 / 0.308 |
| vector / all | 0.515 / 0.326 | 0.758 / 0.537 | 0.758 / 0.537 |
| lexical / all | 0.894 / 0.672 | 0.894 / 0.672 | 0.894 / 0.672 |

Eight held-out queries rank their answer higher and none lower; no category regresses. Terminology remains the open opportunity: vector-only finds 0.846 of those answers, hybrid still 0.615.

For the next run, compare against the `lexical16` report: it is the current baseline. Collecting tuning candidates walks deep result pages; a namespace declared in many files used to make a single match exceed the response budget and fail the page (fixed in plan 7 by shortening that item's declarations). The reproduction notes above still apply.

## Vector floor — search plan 8 (2026-10-17)

**Experiment 1** (`scripts/fusion-experiment.py`, pre-registered in `200e4335`):
- Grid: lexical weight {4, 8, 16, 32} × vector floor {0–3} × lexical rank cap {none, 20, 10}.
- Selection: tuning split only.
- Result: on Maze, every variant reaches tuning Recall@10 1.0, so the rule kept production (`maze-fusion-experiment-1.praxis.json`). The Maze tuning split cannot rank fusion variants.

**Experiment 2:**
- Same grid and rule, with selection on a new blind 30-query Praxis tuning set (`praxis-typescript-tuning-corpus.praxis.json`, committed before collection).
- The tuning set discriminates: production scores 0.827 / 0.683, and the selected lexical 4 + floor 1 scores 0.904 / 0.723 (`praxis-fusion-experiment-2-tuning.praxis.json`).
- The floor keeps the best vector candidate within the first 10 places, at the last non-exact place, so exact matches keep the top and paging stays complete.

**Acceptance through the real service** (neither set was used for selection):

| | Plan 7 | Plan 8 |
|---|---|---|
| Maze held-out hybrid (`maze-release-plan8-results`) | 0.894 / 0.687 | **0.924 / 0.734**, all gates pass |
| Maze terminology | 0.615 / 0.308 | 0.692 / 0.413 |
| Maze behaviour | 0.933 / 0.734 | 1.000 / 0.760 |
| Maze cross-project | 0.923 / 0.410 | 0.923 / 0.515 |
| TypeScript pilot (`praxis-typescript-pilot-plan8-results`) | 0.787 / 0.718 | **0.838 / 0.782** |
| TypeScript terminology | 0.500 / 0.308 | 0.667 / 0.398 |

No category's recall or MRR fell on either set. The current Maze baseline is `maze-release-plan8-results`.

## Lexical term coverage — experiment 3 (2026-10-18): rejected, production kept

**Pre-registered** in `12ec02e2` (`scripts/fusion-experiment-3.py`): lexical weight {2, 4, 8} × coverage exponent {0, 1, 2} × vector floor {1, 2}, where coverage is the share of a query's distinct terms a lexical candidate's search document matches. Selection on the Praxis tuning set only, same rule as experiment 2. The hypothesis was formed after reading plan-8 Maze held-out terminology misses, so Maze held-out is not a blind check of it.

**Tuning** (`praxis-fusion-experiment-3-tuning.praxis.json`): production replays exactly (0.904 / 0.723). Coverage raises MRR at weights 4 and 8 (up to 0.760) but never recall, so the rule selected lexical 2, coverage off, floor 1 (0.923 / 0.756) — a one-query recall gain out of 26.

**Acceptance through the real service**, Maze held-out 80, both builds from the same commit on freshly rebuilt fixtures:

| | Production, plan 8 (`maze-release-plan8-rerun-results`) | Candidate, lexical 2 (`maze-release-experiment3-lexical2-results`) |
|---|---|---|
| hybrid / all | 0.924 / 0.734 | 0.909 / 0.695 |
| crossProject | 0.923 / 0.515 | **0.846** / 0.417 |
| behaviour | 1.000 / 0.760 | 1.000 / 0.650 |
| terminology | 0.692 / 0.413 | 0.692 / 0.438 |

The candidate fails `noCategoryRegressionOver005` (cross-project recall), so it is rejected and plan 8 stays. The production rerun reproduces `maze-release-plan8-results` exactly, which confirms the rebuilt fixture. The TypeScript pilot was not run: one failed acceptance set is sufficient to reject.

Findings: lowering lexical weight trades cross-project recall for nothing on terminology; term coverage improves ordering but not recall at the weights that keep cross-project intact. Terminology remains at 0.692 hybrid against 0.846 vector-only. A further attempt needs a new tuning set with enough cross-project and terminology cases to see this trade before acceptance, since the 30-query Praxis set has few cross-project cases.

Reproducing the Maze fixture (18 October): the corpus revision builds with SDK 10.0.100 (the repository's `global.json`); `capture` SearchCore and UserService, merge by project key (Maze.Common appears in both, identically), add the two `RegexGenerator.g.cs` files to SearchCore's and Maze.Common's `supportSources` (six support files in total), and keep `--fixture` and every `--data` path short.

## Search plan 9 (2026-10-18): containment roots are never results

`search_code` no longer offers a context's synthetic containment root (`[synthetic projectRoot]`), which keyword, semantic and hybrid search all returned for queries such as "Syntax" or "synthetic". It has no source and is never a relevance label, so removing it can only move labelled answers up or leave them in place: Recall@10 and MRR@10 cannot fall. The Maze acceptance was **not** re-run for this change; plan 8's figures remain the last measured baseline. Fusion weights and the vector floor are unchanged.
