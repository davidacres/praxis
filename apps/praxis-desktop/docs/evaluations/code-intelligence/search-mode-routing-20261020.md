# Search mode routing — agents get the best measured mode by default

Date: 2026-10-20. Search plan 12.

Agents call `search_code` without a mode, which used to mean hybrid. After the format-5
representation, semantic-only beat hybrid on natural-language TypeScript/JavaScript questions, and
fusion experiment 4 showed no single hybrid weight serves both those and C#. So the unset mode now
routes instead of retuning: a question of three or more terms goes to semantic-only search when the
index has semantic headers (TypeScript/JavaScript); names, short phrases and header-less indexes
(C#) keep hybrid. An explicit `mode` always wins.

Replayed from the saved floor-2 results (no new collection), labelled non-tuning cases, Hit@10 (MRR@10):

| Corpus | Hybrid (old default) | Semantic only | Routed (new default) |
| --- | ---: | ---: | ---: |
| Desktop, 96 | 75 (0.610) | 78 (0.653) | **78 (0.674)** |
| TypeScript pilot, 40 | 37 (0.754) | 39 (0.814) | **39 (0.839)** |
| markdown-it JavaScript, 20 | 6 (0.084) | 11 (0.297) | **11 (0.297)** |
| Maze C#, 66 | 63 (0.737) | 51 (0.538) | **63 (0.737)** |

Routing never scored below either mode it chooses between. Disclosure: the three-term rule was
chosen after seeing these results; it is the simplest split between names and questions, and every
case is a replay of an already-measured mode, so no mode's ranking changed. In a mixed repository
with headers (Praxis itself has C# services), a C# question also goes to semantic-only.

Semantic-only requests take about 270–300 ms median in Release on the TypeScript fixtures, versus
about 100 ms for hybrid; that is within the agreed half-second budget.

Verified: 202/202 service tests (unit test of the rule, and a model-backed test where a JavaScript
question runs semantic-only while a name and a C# question run hybrid); core bridge tests 17 pass,
2 native-only skips. The `search_code` tool description now tells agents to leave mode unset.
