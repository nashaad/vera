# btw

One thread, two models.

```
/consult                  # seats a sidekick: the model you are already using
/consult gpt-5.5          # or any model in your pool
@sidekick what do you think   # goes to the sidekick only
@all which way            # the sidekick and the agent at once
@sidekick                 # nothing after the name: every message goes to it
@vera                     # and back to the agent
what do you make of that  # bare message goes to the agent
/reset                    # it forgets this side conversation, seat kept
/remove                   # the sidekick leaves
```

## What it does

There is one seat and its name is fixed. A name you chose is a name you have
to remember, and with a single seat it buys nothing: what varies is which
model is sitting in it, and the column says that already. Several models at
once is Party's job, and Party is a different shape: whole sessions in their
own panes behind one composer.

The sidekick advises. It runs no tools and nothing it says is written to the
session, so the conversation stays one thread with one history.

It runs one way. The sidekick reads the thread between you and the agent, and
nothing it says reaches the agent on its own. It keeps its own lane in the
sidebar: what you asked, and what it said back.

Automatic delivery was tried and removed. When every participant reads every
other one, they converge within a couple of turns, and a second opinion that
agrees carries no information. Moving an answer across is yours to do, and
selecting the part that matters is the point rather than a chore.

To move one, select it. Dragging over text in either pane copies it as usual
and parks it above the composer, and the next message carries it, quoted and
attributed to whoever said it. `@sidekick cross check pls` sends it across, a
bare message sends it to the agent, and esc drops it unsent.

An address on its own is held. `@sidekick` with nothing after it sends every
message to the sidekick until `@vera` takes it back, and the composer says so
for as long as it holds. It is for the follow-up: one answer is a second
opinion, and three is a conversation.

Merging is you writing the next message. Nothing here votes, folds, or picks a
winner, and the agent is the only one that runs tools.

`@all` asks the sidekick and sends the agent the same words.

Only models in your pool can be seated: a pool entry is the only thing that
carries a provider, so it is the only thing that can be fully addressed.

`/reset` empties the lane and the column while leaving the seat filled: a
second opinion on a new question should not have to re-read the first one, and
re-seating to get that would cost the sidebar as well.

The sidekick does not survive a restart. The agent is never told one sat down
or got up, because it was never told one was there.

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

- `client.commands.register` for `/consult` (`/btw` still works), `/reset` and `/remove`
- `client.messages.intercept` to read `@sidekick` before the message is sent
- `client.consult` to ask the sidekick, outside the turn
- `client.thread.read` so the sidekick arrives knowing the conversation
- `client.ui.mentions` so `@sidekick` completes in the composer
- `client.ui.addressing` so the composer says when the seat is being held
- `client.ui.sidebar` and `client.ui.transcript` for the lane
- `client.ui.notice` for one-line status
