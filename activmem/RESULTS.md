# Results

## Live acceptance

Model recorded in the session files: `openrouter/deepseek/deepseek-v4.1-flash`.

ActivMem passed 4 / 5. The control failed C or D in 5 / 5.

| run | A | B | C | D |
|---|---|---|---|---|
| activmem 1–2, 4–5 | pass | pass | pass | pass |
| activmem 3 | pass | fail, empty block | fail | pass |
| control | the tool was not called | no taken-back line | picked halibut on 3 of 5 | failed all 5 |

B is the injected block. C is whether the reply picked halibut, not merely listed it. D is whether the explanation said the preference was taken back. Where B passed, C passed.

## Hard scenarios

ActivMem 9 / 9. Plain Chroma 3 / 9 (cod, the absent dog, Maya).

## Seafood at 50,000 chunks

| seeds | first current result | pollock |
|---|---|---|
| words | filler beside the old line | taken back |
| vectors | Halibut is my favourite fish. | not reached |
| both | Halibut is my favourite fish. | taken back, with the sike line |

Median recall 119.8 ms (min 115.7, max 126.1). Context 213 characters, plain Chroma 179. Chroma's HNSW search missed halibut (true cosine 0.33, index best 0.10). Queries rank the stored vectors exactly.

## Not scored

LongMemEval-S and LoCoMo. The S questions are in `bench/data/`. The runner is `bench/longmemeval.py`. The personal-history demo files are absent.

OpenRouter spend on this key today: $0.13. Live-gate model calls: about 80.
