PARTLY

Model recorded in the session files: `openrouter/deepseek/deepseek-v4.1-flash`.

Gate 1 passed. ActivMem passed 4 of 5. The control failed C or D in all 5. On the four passing ActivMem runs, B, C, and D all passed: the block had halibut as current and pollock taken back, the reply picked halibut as the recommendation, and the explanation said the preference was taken back. Run 3 injected an empty block, so there was nothing to pick. When the block was present, the model used it.

The graph over plain Chroma, on the nine hard questions: ActivMem 9 of 9, plain Chroma 3 of 9. Plain Chroma still ranks Toronto above Berlin. ActivMem returns Berlin and shows the earlier cities as taken back.

At 50,000 chunks, words plus vectors return the halibut line first and leave the sike line off the results. Median recall was 119.8 ms, under 200 ms. The injected block was 213 characters against 179 for plain Chroma, so the size half of the cost gate fails. The extra characters are the taken-back line. Chroma's approximate index missed that halibut line among near-duplicate filler; queries rank the stored vectors exactly.

LongMemEval-S is running from `bench/longmemeval.py` and has no scores yet. LoCoMo has not been started. Nash's chat export is not in `demo/`.

About 80 model calls for the live gate and its preflight. The OpenRouter key's spend today is $0.13. No usage limit stopped the run.

The change most likely to fix the biggest miss: keep the injected block no larger than plain Chroma's. The taken-back line is what pushes it over.

Detail: [ACCEPTANCE.md](ACCEPTANCE.md), [RESULTS.md](RESULTS.md), [DECISIONS.md](DECISIONS.md).
