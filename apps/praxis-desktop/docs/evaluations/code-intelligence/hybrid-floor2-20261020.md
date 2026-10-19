# Hybrid vector floor 2 — JavaScript hybrid regression fix

Date: 2026-10-20. Search plan 11, ranking profile `rrf-k60-lexical4-vector1-alias0.5-floor2-v6`.

## Cause

Hybrid search ranks by lexical RRF (weight 4) and vector RRF (weight 1), then guarantees the best
vector candidate a place in the top ten (the "vector floor"). On markdown-it, `markdown-js-15`
(`lib/rules_block/heading.heading`) was vector rank 1 before the semantic-representation change and
was floored into hybrid place 10. Afterwards it was vector rank 2. A different symbol took the
single floored place, so the answer left hybrid's first page. The semantic change did not make the
result worse; the one-place floor turned a small vector reorder into a hybrid miss.

The previous session's attempted fix (hybrid scored on source vectors only) restored JavaScript but
removed the TypeScript hybrid gains, so it was rejected (`hybrid-fix-evidence/`).

## Change

`QueryService.VectorFloor` 1 → 2. The floor loop now places the weaker pick first, skips places
already held by a floored candidate (so the second pick cannot push the first off the page), and
moves each displaced candidate to the top of the next page so paging stays complete. With one
floored candidate the behaviour is identical to the previous code.

The value 2 was chosen from the JavaScript failure mechanism, then checked on every other corpus;
it was not tuned against them. It was first simulated offline from the saved raw responses (the
simulation reproduced every recorded floor-1 score exactly), then confirmed with real replays.

## Results (Release engine, frozen snapshots, Hit@10)

| Corpus / hybrid | Floor 1 | Floor 2 |
| --- | ---: | ---: |
| markdown-it JavaScript, 20 | 5/20, MRR 0.079 | **6/20**, MRR 0.084 |
| Praxis TypeScript pilot, 40 positive | 37/40, MRR 0.754 | 37/40, MRR 0.754 |
| Maze C# held-out, 66 | 61/66 (R@10 0.924), MRR 0.734 | **63/66 (R@10 0.955)**, MRR 0.737 |
| Desktop held-out natural language, 64 | 42/64, MRR 0.413 | **43/64**, MRR 0.415 |
| Desktop all positive, 144 | 106/144 | 107/144 |

No case lost a hybrid hit on any corpus. Lexical and semantic-only result lists are identical to
the previous release replay on every corpus (the change only touches hybrid ordering). All replays:
no tool errors, no duplicates, databases unchanged, full semantic coverage.

JavaScript hybrid is back to the pre-change baseline of 6/20. It is still low because lexical finds
only 3/20 on this corpus and hybrid weights lexical 4:1. Semantic-only (11/20) is the better mode
for paraphrased questions there. Raising the vector weight is a separate fusion experiment and needs
the tuning-split protocol.

The replay transport was compiled against the previous assembly, so its `benchmark_metadata`
reports the inlined old profile string; the hybrid list changes confirm the new floor ran.
Latency was not re-measured: the change reorders at most two candidates in an already-built list.

## Verification

- Full service suite with model, .NET and TypeScript fixtures: **200/200**, none skipped.
  `TheBestVectorCandidatesAreKeptOnTheFirstPageAndPagingStaysComplete` now checks two floored
  paraphrase matches land in places 9 and 10, in model order, with paging complete.
- Raw evidence: `.praxis/session-artifacts/code-intelligence-benchmark/floor2-{javascript,typescript,maze,desktop}/`.
