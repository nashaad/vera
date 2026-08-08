# multi-seat

One thread, several models.

```
/add gpt-5.5 as m1        # m1 joins the conversation
@m1 what do you think     # goes to m1 only; m1 is now the incumbent
say more                  # bare message goes to the incumbent
@all which way            # every seat at once, plus the agent
@agent go with that       # back to the agent
/seats                    # who is here, and who answered last
/drop m1                  # m1 leaves
```

## What it does

Extra seats advise. They run no tools and nothing they say is written to the
session, so the conversation stays one thread with one history.

Each seat keeps its own lane: what it was told, what it said, and the other
seats' replies quoted as `[m1 (gpt-5.5) replied:] ...`. The agent gets the same
treatment. Replies it has not seen yet are quoted above the next message you
write.

Merging is you writing the next message. Nothing here votes, folds, or picks a
winner, and the agent is the only one that runs tools.

`@all` asks every seat in parallel. The agent's turn starts immediately, so it
sees that round's replies on your next message, not this one.

## Install

Add it to your Vera config:

```json
{
  "extensions": [
    { "path": "/path/to/vera/examples/extensions/multi-seat", "enabled": true }
  ]
}
```

## Capabilities it uses

- `client.commands.register` for `/add`, `/seats`, `/drop`
- `client.messages.intercept` to read `@alias` before the message is sent
- `client.consult` to ask a seat, outside the turn
- `client.ui.transcript` to show a seat's answer
- `client.ui.notice` for one-line status
