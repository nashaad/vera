# Results

## Hard scenarios

`ACTIVMEM_RUN_VECTORS=1 uv run python demo/hard.py` — 9 / 9 passed.

| # | Question | ActivMem | Plain words |
|---|---|---|---|
| 1 | What fish do I like? under filler | Halibut first. Pollock suppressed, sike attached | same, this one does not need vectors |
| 2 | What seafood do I like? | Halibut 0.980, sike 0.853, pollock suppressed | sike 0.793 first, halibut 0.132 second |
| 3 | Where do I live? | Berlin current. Toronto and Lisbon suppressed | no `live` term, so words return nothing |
| 4 | Where do I work? / in 2020 | Corvine now, Acme for 2020-06-01 | same |
| 5 | Why do I love cod? | `no_record_of: love, cod`. No cod excerpt | same |
| 6 | What's my dog's name? | nothing | same |
| 7 | Tuna decoy | Halibut first. Tuna inferred, lower | same |
| 8 | Where does Maya's partner work? | Bakery, via Sam | same |
| 9 | Who should I ask? after the routing question | Priya | same, from leftover heat |

Plain Chroma, on the city question, ranks "I'm back in Toronto" (cosine 0.212) above "Berlin now" (0.135). The graph is what makes Berlin the current answer. On seafood, the best cosine scores are close (Lisbon 0.374, halibut 0.358 when both are stored). Halibut still ranks first once activation runs. A seafood question can also surface Berlin if Lisbon was a near neighbour, because the revision chain wakes the latest city. That is the sharpest false friend in these runs.

## Latency

| Path | Time |
|---|---|
| Words + graph, 50,000 chunks, one question | 0.6 ms, 65 nodes |
| Words + Chroma + graph, warmed, a handful of chunks | median 110.5 ms over 15 calls (min 104, max 115). About 110 ms of that is the local MiniLM query |
| Reopen after 25 cached fake embeddings | 0 new embeds |

The 200 ms budget holds for the warmed small store. It was not re-measured with 50,000 real embeddings. Embedding that many chunks was not run.

## Not run

- Live Vera acceptance (`acceptance/halibut_live.py`). A private home has no model route. The daily home was left alone.
- LongMemEval-S and LoCoMo. No local dataset. A full answer-and-judge sweep was not started, so spend stays $0.
- `demo/my_history_export.json` and `demo/my_history_gold.yaml` are absent.
