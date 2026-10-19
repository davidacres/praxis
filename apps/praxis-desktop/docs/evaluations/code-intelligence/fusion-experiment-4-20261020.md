# Fusion experiment 4 — rejected

Date: 2026-10-20. Script: `services/code-intelligence/scripts/fusion-experiment-4.py`.
Production stays at plan 11, `rrf-k60-lexical4-vector1-alias0.5-floor2-v6`.

## Question

After the format-5 semantic representation, semantic-only beat hybrid on natural-language
TypeScript/JavaScript questions. Two levers were tested: (a) letting hybrid's vector channel use the
`SemanticQueryViews` rephrasings that semantic-only uses, and (b) lowering the lexical weight from 4.
The hypothesis was formed after seeing those held-out gaps, so only the tuning corpus and the Maze
held-out split are blind.

Grid (fixed before collection): vector channel {single, views} × lexical weight {1, 2, 4}, floor 2,
no cap. Rule: TypeScript tuning-corpus Recall@10, then MRR@10, then closest to production. Accept
only if the Maze held-out split and the TypeScript pilot do not regress.

## Results (hybrid, frozen Release snapshots)

| Corpus | single-lex4 (production) | single-lex1 (selected) | views-lex1 |
| --- | ---: | ---: | ---: |
| TypeScript tuning, 26 (selection) | R 0.923, MRR 0.721 | R 0.923, **MRR 0.771** | R 0.923, MRR 0.755 |
| **Maze C# held-out, 66 (guard)** | **R 0.955, MRR 0.738** | R 0.939, MRR 0.668 | R 0.939, MRR 0.668 |
| TypeScript pilot, 40 (guard) | R 0.875, MRR 0.754 | R 0.887, MRR 0.797 | R 0.900, MRR 0.799 |
| markdown-it JavaScript, 20 (report) | R 0.300, MRR 0.084 | R 0.300, MRR 0.177 | R 0.300, MRR 0.186 |

All six configurations tied on tuning recall; lexical 1 won on MRR. Query views made no difference
on C# (no semantic headers there) and helped only marginally on TypeScript.

## Decision

**Rejected.** The selected configuration loses one Maze held-out hit and 0.07 MRR. Lowering the
lexical weight helps TypeScript and JavaScript ranking but hurts C#, where keyword matching is
stronger. One global weight cannot serve both on this evidence.

A language-aware weight (lexical 1 for TypeScript/JavaScript contexts, 4 for C#) is the obvious next
candidate, but it would be a new, separately recorded experiment with its own tuning split; these
held-out results cannot select it. Raw candidate ranks and per-corpus reports are under
`.praxis/session-artifacts/code-intelligence-benchmark/fusion4/`. The 168-query desktop set was
still collecting when this was written; it is report-only and cannot change the decision.
