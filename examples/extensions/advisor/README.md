# advisor

One thread, several models.

```
/add gpt-5.5 as m1        # m1 joins the conversation as an advisor
@m1 what do you think     # goes to m1 only
@all which way            # every advisor at once, plus the agent
what do you make of that  # bare message goes to the agent
/remove m1                # m1 leaves
/remove all               # everyone leaves
```

## What it does

Advisors advise. They run no tools and nothing they say is written to the
session, so the conversation stays one thread with one history.

Each advisor keeps its own lane in the sidebar: what it was told, what it said,
and the other advisors' replies quoted as `[m1 (gpt-5.5) replied:] ...`. The
agent gets the same treatment. Replies a participant has not seen yet are
quoted above the next message you send it.

Merging is you writing the next message. Nothing here votes, folds, or picks a
winner, and the agent is the only one that runs tools.

`@all` asks every advisor in parallel. The agent's turn starts immediately, so
it sees that round's replies on your next message, not this one.

Only models in your pool can be seated: a pool entry is the only thing that
carries a provider, so it is the only thing that can be fully addressed.
`maxSeats` caps how many sit at once, and defaults to 1.

Advisors do not survive a restart. On resume the extension tells the agent once
that they are gone, so it stops speaking as though they were still here.

## Install

Add it to your Vera config:

```json
{
  "extensions": [
    { "path": "/path/to/vera/examples/extensions/advisor", "enabled": true }
  ]
}
```

## Capabilities it uses

- `client.commands.register` for `/add` and `/remove`
- `client.messages.intercept` to read `@alias` before the message is sent
- `client.consult` to ask an advisor, outside the turn
- `client.thread.read` so an advisor arrives knowing the conversation
- `client.ui.mentions` so `@alias` completes in the composer
- `client.ui.sidebar` and `client.ui.transcript` for the lanes
- `client.ui.notice` for one-line status
