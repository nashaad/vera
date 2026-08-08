# btw

One thread, several models.

```
/btw gpt-5.5 as m1        # m1 joins the conversation as an advisor
@m1 what do you think     # goes to m1 only
@all which way            # every advisor at once, plus the agent
@m1                       # nothing after the name: every message goes to m1
@vera                     # and back to the agent
what do you make of that  # bare message goes to the agent
/remove m1                # m1 leaves
/remove all               # everyone leaves
```

## What it does

Advisors advise. They run no tools and nothing they say is written to the
session, so the conversation stays one thread with one history.

It runs one way. An advisor reads the thread between you and the agent, and
nothing an advisor says reaches the agent or another advisor on its own. Each
one keeps its own lane in the sidebar: what you asked it, and what it said
back.

Automatic delivery was tried and removed. When every participant reads every
other one, they converge within a couple of turns, and a second opinion that
agrees carries no information. Moving an answer across is yours to do, and
selecting the part that matters is the point rather than a chore.

To move one, select it. Dragging over text in either pane copies it as usual
and parks it above the composer, and the next message carries it, quoted and
attributed to whoever said it. `@m1 cross check pls` sends it to an advisor, a
bare message sends it to the agent, and esc drops it unsent.

An address on its own is held. `@m1` with nothing after it sends every
message to m1 until `@vera` takes it back, and the composer says whose name it
is holding for as long as it holds one. A seat that leaves lets go. It is for
the follow-up: one answer is a second opinion, and three is a conversation.

Merging is you writing the next message. Nothing here votes, folds, or picks a
winner, and the agent is the only one that runs tools.

`@all` asks every advisor in parallel, and sends the agent the same words.

Only models in your pool can be seated: a pool entry is the only thing that
carries a provider, so it is the only thing that can be fully addressed.
`maxSeats` caps how many sit at once, and defaults to 1.

Advisors do not survive a restart. The agent is never told one sat down or got
up, because it was never told they were there.

## Install

Add it to your Vera config:

```json
{
  "extensions": [
    { "path": "/path/to/vera/examples/extensions/btw", "enabled": true }
  ]
}
```

## Capabilities it uses

- `client.commands.register` for `/btw`, `/seats` and `/remove`
- `client.messages.intercept` to read `@alias` before the message is sent
- `client.consult` to ask an advisor, outside the turn
- `client.thread.read` so an advisor arrives knowing the conversation
- `client.ui.mentions` so `@alias` completes in the composer
- `client.ui.addressing` so the composer says which seat is being held
- `client.ui.sidebar` and `client.ui.transcript` for the lanes
- `client.ui.notice` for one-line status
