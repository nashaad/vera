DID NOT WORK

Gate 1 did not run, so this is not a finding that the halibut idea failed. A fresh Vera home answers `No model route` until it has a provider, and this pass did not point the test at the daily `~/.vera` home. OpenRouter and OpenAI keys are present in the environment. Model spend was $0.

What did run: the memory checks. All nine hard scenarios passed, including paraphrase and the Lisbon → Toronto → Berlin chain, where plain similarity ranks Toronto highest and the graph returns Berlin with the two earlier lines suppressed. On "What seafood do I like?", words alone rank the sike line first and halibut second; vectors and words+graph both rank halibut first and keep pollock suppressed. Warmed recall on that small store is about 110 ms median, almost all of it the local embedder. The 50,000-turn word recall is 0.6 ms and touches 65 nodes. A 50,000-chunk Chroma index was not built.

The biggest miss is that Vera never actually took a turn with the hook. The extension and the socket are in place. The single change that would finish the verdict is a headless Vera home with a model route, then `uv run python acceptance/halibut_live.py`. LongMemEval and LoCoMo were not run; there is no local copy, and a full answer-and-judge pass would spend the budget before the live halibut test. Nash's own chat export was not in `demo/`, so that demo was skipped.

Detail: [ACCEPTANCE.md](ACCEPTANCE.md), [RESULTS.md](RESULTS.md), [DECISIONS.md](DECISIONS.md).
