# Scheduling

Vera's resident host owns the clock. The schedule database owns definitions and
occurrences. Each occurrence becomes an ordinary durable inbox entry, and the
recipient reads and acknowledges it through the existing inbox API.

```text
clock -> schedule occurrence -> durable inbox -> participant
```

Create a five-field cron schedule with a stable participant ID:

```sh
vera schedule add daily-review \
  --cron "0 9 * * *" \
  --timezone America/New_York \
  --to claude:reviewer \
  --text "Review open work"
```

`--timezone` defaults to `UTC`. Use `--payload '{"job":"review"}'` instead of
`--text` when the recipient expects structured JSON.

```sh
vera schedule list
vera schedule show daily-review
vera schedule pause daily-review
vera schedule resume daily-review
vera schedule run daily-review
vera schedule remove daily-review
```

`run` creates an immediate occurrence even while paused. After downtime, Vera
coalesces missed times into one occurrence. A transient delivery failure stays
pending and retries; a restart cannot duplicate the inbox entry.

An `emitted` run has reached the durable inbox. The recipient's normal inbox
acknowledgement proves retrieval, not execution or comprehension. A participant
that has joined before can leave and later resume from its durable offset; join
external participants once before targeting them with schedules.

`show` includes the newest 100 occurrences plus the total run count, keeping the
host response bounded while the authoritative run history remains durable.
