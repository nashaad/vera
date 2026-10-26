# Results

## Live acceptance

BLOCKED. The answering model had to be `openai-codex/gpt-6-luna`. This worktree's `vera library list` contains only `openrouter/openai/gpt-5.6-luna`. No model call was made. The OpenRouter run from the previous pass does not count.

## Hard scenarios

ActivMem 9 / 9. Plain Chroma, graph off, 3 / 9 (cod, the absent dog, Maya).

| # | ActivMem | Plain Chroma |
|---|---|---|
| 1 fish under filler | halibut first, pollock taken back | no suppression |
| 2 seafood | halibut 0.980, pollock taken back | no suppression |
| 3 cities | Berlin current; Toronto and Lisbon taken back | Toronto ranks above Berlin |
| 4 time | Corvine now, Acme in 2020 | no true_at filter |
| 5 cod | no record | no record |
| 6 dog | nothing | nothing |
| 7 decoy | halibut, then inferred tuna | tuna not kept below a confirmed line |
| 8 Maya | bakery via Sam | bakery is already a vector neighbour |
| 9 Priya | found from leftover heat | not found |

## Seafood at 50,000 chunks

Same question, three seed modes:

| seeds | first current result | pollock |
|---|---|---|
| words | filler beside the old pollock line | taken back |
| vectors | Halibut is my favourite fish. | not reached |
| both | Halibut is my favourite fish. | taken back, with "sike, I don't" |

"sike, I don't" is not itself a result. Median recall over 20 warmed calls: 119.8 ms (min 115.7, max 126.1), 65 nodes. The injected block is 213 characters. Plain Chroma's block for the same question is 179. Reopening the store re-embedded nothing.

## Not run

LongMemEval-S, LoCoMo, and the personal-history demo. `demo/my_history_export.json` and `demo/my_history_gold.yaml` are absent. Model calls this pass: 0.
