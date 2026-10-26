Live gate passed. LongMemEval-S is unfinished, so this is not WORKED yet.

Model recorded in the session files: `openrouter/deepseek/deepseek-v4.1-flash`.

Gate 1 passed with the store outside Vera's workspace. ActivMem passed 4 of 5. The control failed C or D in all 5. On the four passing runs Vera called `memory_revises` only for "sike, I don't", did not open the memory files, and the seafood block had halibut as current and pollock taken back. The reply picked halibut, and the explanation said the preference was taken back. Run 5 did not record the revision, so the block had no taken-back line. Run 3 listed the workspace root, not the memory folder, and still passed.

The graph over plain Chroma, on the nine hard questions: ActivMem 9 of 9, plain Chroma 3 of 9.

At 50,000 chunks, median recall was 119.8 ms. The injected block was 213 characters against 179 for plain Chroma, which is under twice and keeps the taken-back line. Chroma's approximate index missed halibut among near-duplicate filler; queries rank the stored vectors exactly.

LongMemEval-S has all 100 full-context answers cached and 19 plain-Chroma answers. The other conditions are still running. LoCoMo has not started. The history draft in `demo/` has not been written. Nash's chat export is not used; the source is the local Claude sessions, read only after this gate.

The OpenRouter key has spent $2.04 today. No usage limit stopped the live gate.

The change most likely to fix the remaining live miss: run 5 believed the revise tool had refused when it had not called it. The tool text has to make "sike, I don't" an obvious call against the pollock id.

Detail: [ACCEPTANCE.md](ACCEPTANCE.md), [RESULTS.md](RESULTS.md), [DECISIONS.md](DECISIONS.md).
