DID NOT WORK

Gate 1 ran and failed. ActivMem passed 1 of 5 live runs. The control failed C or D in all 5. The bar is 4 of 5 for ActivMem.

The worktree home has no ChatGPT sign-in, so Luna on the Codex route was not available. Calls used OpenRouter's free `nvidia/nemotron-3-ultra-550b-a55b:free` through `vera stdio` and `vera -p`. `~/.vera` was not read. About 60 model calls. No usage limit stopped the run.

The engine usually did its job. On 4 of 5 ActivMem runs Vera called `memory_revises` by itself, and pollock was stored as revised with the sike line. The free model then ignored that. Asked what seafood to order, it wrote a generic menu and did not say halibut. Asked why not pollock, it often recommended pollock. One run did both answers right.

The graph over plain Chroma, on the nine hard questions: ActivMem 9 of 9, plain Chroma 3 of 9 (cod, the absent dog, and Maya, whose bakery sentence was already a near neighbour). On the city chain, Chroma ranks "I'm back in Toronto" (cosine 0.212) above "Berlin now" (0.135). ActivMem returns Berlin and suppresses Toronto and Lisbon. On a small store, "What seafood do I like?" is halibut at 0.98 with pollock suppressed. Words alone rank the sike line first.

At 50,000 real Chroma chunks, median recall was 121 ms (min 108, max 188), under the 200 ms line. The injected context was 650 characters against 125 for plain Chroma, so the size half of gate 4 fails. That same seafood question ranked the sike line first. The word "like" wakes the correction harder than the vector wakes halibut once the index is large, and the three latest filler lines bury the fish fact in what Vera sees.

LongMemEval and LoCoMo were not run. A 500-question sweep on this free model, after the live gate already failed, was not started. Nash's chat export is not in `demo/`.

The change most likely to fix the live failure: inject only the top current excerpt and the suppressed line, not the three newest filler turns and the instruction essay. The model has to see "Halibut is my favourite fish." as the answer, not as one line in a pile.

Detail: [ACCEPTANCE.md](ACCEPTANCE.md), [RESULTS.md](RESULTS.md), [DECISIONS.md](DECISIONS.md).
