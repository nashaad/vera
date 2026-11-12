# vera-telemetry

An example extension that sends one event per model call, plus session ends and
cache-miss findings, to a hosted log service. The default destination is Axiom's
edge ingest in US East 1 (AWS); `sink.url` changes it. Adding another backend is
one file under `src/sinks/` and a new `sink.type`; event building, batching and
the cache-miss rule stay as they are.

The extension is off unless its config has a `sink`. A `sink` that is present
but malformed fails activation with a `telemetry: ...` message; it does not
quietly fall back to off.

## Setup

1. In Axiom, create a dataset named `crow-nest`, then an API token with only
   ingest permission on that dataset.
2. Export the token in the environment that starts the Vera host:

   ```sh
   export AXIOM_TOKEN=xaat-...
   ```

   The host resolves the `{env:AXIOM_TOKEN}` reference below from that
   environment just before it loads the extension.
3. Add an entry to the `extensions` list in the home's `config.json`, with
   `path` set to the absolute path of `examples/extensions/telemetry` and the
   `config` block shown under [Config](#config). The entry loads the extension.
   Do not run `/extension install` for it: an installed copy runs with no
   config, so it stays off.
4. Restart the host side: Ctrl+P, then **Reconnect host**. Host code loads at
   host startup, so a config change applies only after this restart. The
   restarted host must see `AXIOM_TOKEN`; an unset variable stops the
   extension from loading and the startup note names it.

`vera -p` print mode does not load config extensions, so it sends nothing.

## What leaves the machine

Events carry counts, timings, provider and model names, and hashes. Prompts,
messages, tool schemas, completions and tool output are never sent. The four
request fields that could carry content are hashed instead:

- `system_hash`, `tools_hash`: first 12 hex characters of SHA-256 over a
  canonical form of the system prompt and the tool list (object keys sorted,
  request order kept).
- `message_hashes`: the same hash for the first four input messages, in order.
- `prefix_changed`: the first part of the prefix that differs from the
  session's previous call (`system`, `tools`, `message:0` to `message:3`, or
  null). Growth at the end of the conversation is not a change.

An error is the provider's own wording cut to 300 characters. Providers can
echo part of a request in an error, so treat that field as the one place a
short piece of request text can appear.

The install id is a random UUID stored once in the extension's profile
directory. It labels a machine and a profile, not a person. `developer` is
whatever label the config sets, or absent.

## Events

`model_call`, one per finished or failed call:

| Field | Meaning |
| --- | --- |
| `input_tokens` | Includes cached tokens |
| `cached_input_tokens` | Tokens the provider reports as cache hits |
| `output_tokens` | Tokens generated |
| `latency_ms` | Request start to terminal event |
| `stop_reason` | Provider stop reason, or `error` / `aborted` |
| `error` | First 300 characters, failures only |
| `cache_retention` | `short`, `long` or `none` |
| `has_cache_key` | Whether a cache key was sent at all |
| `message_count`, `tool_count` | Request sizes |
| `system_hash`, `tools_hash`, `message_hashes` | See above |
| `prefix_changed` | See above |

`cache_miss`, when a call re-read a prompt it had just cached:

| Field | Meaning |
| --- | --- |
| `input_tokens`, `cached_input_tokens` | This call |
| `previous_input_tokens`, `previous_cached_input_tokens` | The call before it |
| `reread_tokens` | `min(previous input, input) - cached` |
| `gap_ms` | Time between the two calls |
| `prefix_changed` | The same value as the `model_call` that carries it |

The rule compares each call with the previous call in the same session. It
fires when all of these hold:

- the same provider and model;
- less than five minutes since the previous call;
- input is at least 70% of the previous input, so compaction does not count;
- the provider has reported a cached token at some point;
- at least 8192 tokens were re-read, and that is at least half of the smaller
  input.

`session_end`, one per session close, with `reason` from the hook. Provider,
model and purpose repeat the session's last call; they are empty for a session
that made none.

`telemetry_dropped`, with `dropped`, the number of events discarded since the
previous flush. Its session, provider and model are empty because drops are
counted across sessions.

Every event also carries `time`, `event`, `install_id`, `developer`,
`session_id`, `parent_session_id` and `purpose` (`turn` or `ask`) where they
apply.

## Config

The host resolves `{env:NAME}` in extension config before load, so the token
belongs in the config as a reference, not as its value:

```json
{
    "extensions": [
        {
            "path": "/absolute/path/to/examples/extensions/telemetry",
            "config": {
                "developer": "blackfeather",
                "sink": {
                    "type": "axiom",
                    "dataset": "crow-nest",
                    "token": "{env:AXIOM_TOKEN}",
                    "url": "https://us-east-1.aws.edge.axiom.co"
                },
                "flush_seconds": 10,
                "cache_miss": {
                    "min_reread_tokens": 8192,
                    "min_share": 0.5
                }
            }
        }
    ]
}
```

- `sink.type` is `axiom` or `jsonl`.
- `sink.dataset` is required for Axiom. A missing or blank one fails
  activation.
- `sink.token` is required for Axiom.
- `sink.url` defaults to the US East 1 edge base. Axiom serves edge ingest at
  `POST {url}/v1/ingest/{dataset}?timestamp-field=_time` and reads the `_time`
  field as the event timestamp, so the sink renames `time` on the way out.
- `flush_seconds` defaults to 10.
- `cache_miss` defaults are shown above.
- `sink.type: "jsonl"` appends to `events.jsonl` in the extension's profile
  directory. It needs no token and exists for local use and tests.

## Delivery

Events wait in a memory queue capped at 1000; the oldest is dropped first and
the drops are counted. The queue is sent every `flush_seconds` and as soon as
it holds 100 events. A failed send keeps its batch for one retry at the next
flush and then discards it. A send that takes longer than 10 seconds is
aborted. Nothing is spooled to disk. On deactivate the timer stops and the
queue gets one last send. A session end also starts a send, so its event leaves
with the rest of the queue instead of waiting for the timer.

The host API exposes no Vera version, so events do not carry `vera_version`.

## Axiom queries

APL against the `crow-nest` dataset. `_time` is the event time written by
the sink.

Cache misses by provider and model over time:

```apl
['crow-nest']
| where event == "cache_miss"
| summarize misses = count(), reread_tokens = sum(reread_tokens)
    by bin(_time, 1h), provider, model
| order by _time asc
```

Misses by `prefix_changed`:

```apl
['crow-nest']
| where event == "cache_miss"
| summarize misses = count() by prefix_changed
| order by misses desc
```

A null `prefix_changed` means the miss happened with an unchanged prefix.

Errors by provider:

```apl
['crow-nest']
| where event == "model_call" and isnotempty(error)
| summarize errors = count() by provider
| order by errors desc
```

## Test

```bash
bun test
```
