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

Models: `sentence-transformers/all-MiniLM-L6-v2` at the pinned revision; `BAAI/bge-small-en-v1.5` at `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` (model SHA-256 `828e1496…40cf35`, CLS pooling, `vocab.txt` byte-identical to MiniLM's, MIT), without and with the query instruction `Represent this sentence for searching relevant passages: `. The bge runs used an unmerged second profile in `LocalModel` (branch `exp/embedding-eval`, commit `0faa104b`). Every declared gate passed in all three; all four compiler contexts were complete; vector p95 was ~80 ms in each.

Findings: hybrid is unchanged because the 64:1 lexical weight makes the model irrelevant to ranking — a model change alone does not move the shipped default. Vector-only, bge-small with the instruction beat MiniLM on 25 held-out queries and lost 2; terminology rose 0.615 → 0.846, above lexical's 0.615. Any hybrid gain needs fusion retuned with that model on the tuning split only, then the held-out gate. This MiniLM run is the reference baseline for that work: it reproduces `maze-release-configured-dependencies-results` exactly.

Reproducing: build `Maze.SearchCore` and `Maze.UserService` at the corpus revision with `-p:EmitCompilerGeneratedFiles=true -p:CompilerGeneratedFilesOutputPath=obj/scip-generated`; `capture` each (its `--output` must be repository-relative) and merge the two manifests' projects; add each project's `obj/scip-generated/.../RegexGenerator.g.cs` to `supportSources` (six support files in total) or SearchCore and Common resolve `partial` and lexical drops to 0.879. Run `evaluate-maze-release.py` with a short `--fixture` path: the owner's Unix socket lives in the data directory and a long path fails with "Owner directory is too long for a Unix socket."
