DID NOT WORK

Gate 1 ran and failed. ActivMem passed 1 of 5 live runs. The control failed C or D in all 5. The bar is 4 of 5 for ActivMem.

The model was `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`. `openai-codex/gpt-6-luna` is still not in this worktree's library. Nash said to use any free Nemotron. About 60 model calls for the scored runs. No usage limit stopped the run. `~/.vera` was not read.

The engine did its job. On all 5 ActivMem runs Vera called `memory_revises` by itself. On 4 of 5, the injected block had "Halibut is my favourite fish." as current and pollock taken back with "sike, I don't". The model then ignored that line and wrote a generic seafood menu, so the reply never said halibut. Asked why not pollock, it did say the preference was taken back on 4 of 5. The control never recorded a revision, and its "why not pollock" reply failed every time.

The graph over plain Chroma, on the nine hard questions: ActivMem 9 of 9, plain Chroma 3 of 9. At 50,000 chunks, words plus vectors return the halibut line first and keep the sike line off the results. Median recall was 119.8 ms. The injected block is 213 characters against 179 for plain Chroma.

LongMemEval and LoCoMo were not run. The live answers already failed the gate. Nash's chat export is not in `demo/`.

The change most likely to fix the live failure: the reply has to recommend the Current line. The model is shown the halibut sentence and still writes a menu that does not name it.

Detail: [ACCEPTANCE.md](ACCEPTANCE.md), [RESULTS.md](RESULTS.md), [DECISIONS.md](DECISIONS.md).
