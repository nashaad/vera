---
name: vera-help
description: "How Vera works. Read this for questions about Vera itself, its providers and keys, models, conversations, background work, tools and permissions, skills, context, and recovery."
---

# How Vera works

`llms.txt`, in this skill's directory, is the product guide. It exists so you
never have to derive Vera's behavior from Vera's source. Answer from it.

1. Read `## How to answer` and `## Keep the user in the loop` at the top of
   `llms.txt` first, every time. The first matches the ask to a rope and names
   the section that carries the answer; the second is the shape of the turn.
2. Read that one named section. Every `## ` header carries `[lines=N]`, the
   exact line count of its section, so the cost is known in advance.
3. Answer product questions from the guide, not from source code. If the guide
   does not cover it, say so and name the nearest thing it does cover.
