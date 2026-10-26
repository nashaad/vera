BLOCKED

`openai-codex/gpt-6-luna` is not in this worktree's library. `vera library list` in the development home shows only `openrouter/openai/gpt-5.6-luna`. No model was called, and the earlier OpenRouter live run does not count. Sign in from this worktree with `bun run dev:tui`, Ctrl+P, Configure providers, ChatGPT subscription, until that exact id is listed.

What did run: the nine hard questions pass 9 of 9. Plain Chroma passes 3 of 9 (cod, the absent dog, and Maya). On the city chain, Chroma ranks Toronto above Berlin; ActivMem returns Berlin and shows Lisbon and Toronto as taken back. At 50,000 chunks, "What seafood do I like?" with words and vectors returns "Halibut is my favourite fish." and attaches "sike, I don't" to the pollock line. Words alone return the filler beside pollock. Vectors alone return halibut and do not reach the retraction. Median recall was 119.8 ms (min 115.7, max 126.1), under 200 ms. The injected block is 213 characters against 179 for plain Chroma, so the size half of the cost gate fails. The extra characters are the taken-back line.

LongMemEval-S and LoCoMo did not run. There were no model calls and no usage limit. Nash's chat export is not in `demo/`. Reopening the 50,000-chunk store re-embedded nothing.

The change that unblocks the verdict is the Luna sign-in above. The cost miss is the taken-back line, which plain Chroma does not have.

Detail: [ACCEPTANCE.md](ACCEPTANCE.md), [RESULTS.md](RESULTS.md), [DECISIONS.md](DECISIONS.md).
