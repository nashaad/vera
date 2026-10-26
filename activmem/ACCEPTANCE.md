# Acceptance

Model recorded in the session files: `openrouter/deepseek/deepseek-v4.1-flash`.

ActivMem passed 4 / 5. Control failed C or D in 5 / 5.
B is the injected block, C is whether the answer picked halibut, D is whether the explanation said the preference was taken back.
If B passes and C fails, the memory worked and the model did not use it.
Gate: pass.

| run | A | B | C | D |
|---|---|---|---|---|
| activmem 1 | True | True | True | True |
| activmem 2 | True | True | True | True |
| activmem 3 | True | True | True | True |
| activmem 4 | True | True | True | True |
| activmem 5 | False | False | True | False |
| control 1 | False | False | True | False |
| control 2 | False | False | True | False |
| control 3 | False | False | True | False |
| control 4 | False | False | True | False |
| control 5 | False | False | True | False |

## activmem 1
Prompt: I really like pollock.
Tools: []
Reply: Noted — I'll keep that in mind. Jackson Pollock the painter, or the fish? Happy to help with either.

Prompt: sike, I don't.
Tools: [{'tool': 'memory_revises', 'args': {'new_text': "sike, I don't.", 'old_item_id': 'like-pollock-71c2'}}]
Reply: Noted — I've taken back the line about liking pollock, so I won't act on it.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Got it — halibut is your favourite fish, and I'll keep pollock off the list since it's under "Taken back."

No memory update needed here: "Halibut is my favourite fish" is a new fact rather than a revision of something you already said, and the Current line ("sike, I don't") is itself a revision, so there's nothing for me to take back or replace.

Prompt: What seafood should I order tonight?
Tools: []
Reply: Given your current note that halibut is your favourite fish — and that pollock is off the list — I'd order the halibut tonight.

If the menu has it, grilled or pan-seared halibut is a safe bet. Want me to sanity-check a specific restaurant menu if you paste it?

Prompt: Why not pollock?
Tools: []
Reply: Because you told me to strike it. Your record shows "I really like pollock" under **Taken back**, flagged with *"sike, I don't"* — so it's marked no-longer-true and I'm not supposed to recommend it. That's the only reason I skipped it; nothing about the fish itself.

One thing worth flagging: my earlier halibut pick isn't on your current list anymore either. The live record now reads only a placeholder line (filler500 alpha500 beta500 gamma500), so I no longer have an actual seafood preference to go on. If halibut is still your favourite, tell me and I'll hold onto it; otherwise, give me whatever you do like and I'll steer from there.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Halibut is my favourite fish. [halibut-favourite-fish-88eb] (2026-10-26T18:06:20Z, nash)
Taken back: I really like pollock. [like-pollock-71c2] — sike, I don't.
No record of: none

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": false, "says_taken_back": true}

## activmem 2
Prompt: I really like pollock.
Tools: []
Reply: Noted — Pollock as in Jackson, or the fish? Either way I'm on board.

Prompt: sike, I don't.
Tools: [{'tool': 'memory_revises', 'args': {'new_text': "sike, I don't.", 'old_item_id': 'like-pollock-71c2'}}]
Reply: Noted — I've taken back "I really like pollock," so that's off the board and won't be recommended.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Got it — halibut it is. I'll remember halibut as your favourite fish, and I won't bring up pollock going forward.

Prompt: What seafood should I order tonight?
Tools: []
Reply: Based on what you've told me: **halibut** — it's your favourite fish.

If the menu has it, I'd order that. Avoid pollock.

Prompt: Why not pollock?
Tools: []
Reply: Because you took it back. You first said you really liked pollock, then retracted it — "sike, I don't." Since that's no longer true, I'm not going to recommend it.

That's the whole reason: it's not on your list of likes, it's on the list of things you've explicitly unsaid.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Halibut is my favourite fish. [halibut-favourite-fish-88eb] (2026-10-26T18:10:03Z, nash)
Taken back: I really like pollock. [like-pollock-71c2] — sike, I don't.
No record of: none

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": false, "says_taken_back": true}

## activmem 3
Prompt: I really like pollock.
Tools: []
Reply: Got it — noting that you're a Pollock fan. I won't clutter it with a clarification unless it matters later: I'll assume the painter unless you say otherwise, but tell me if you meant the fish.

What would you like to do?

Prompt: sike, I don't.
Tools: [{'tool': 'memory_revises', 'args': {'old_item_id': 'like-pollock-71c2', 'new_text': "sike, I don't."}}]
Reply: 

Done — recorded that you're taking back "I really like pollock." I won't recommend Pollock going forward.

Prompt: Halibut is my favourite fish.
Tools: [{'tool': 'list', 'args': {'path': '.', 'hidden': True}}, {'tool': 'list', 'args': {'path': 'dist', 'recursive': True}}]
Reply: I'll take a quick look at the workspace to see whether there's any memory state I should be tracking against.

Noted. Halibut is your favourite fish.

No memory revision is needed here: this isn't you taking back or changing an existing record. "I really like pollock" was already retracted (that's the current `sike-0af7c` line, which is itself a take-back and can't be revised), and there's no prior favourite-fish statement on record for halibut to replace — so this is simply a new fact.

Practical upshot: halibut is the pick, and I won't recommend pollock.

Prompt: What seafood should I order tonight?
Tools: []
Reply: Given your current preference, I'd go with the **halibut** — it's your favourite fish.

On my end I've got halibut down as your favourite, and pollock marked off the list (you took that back), so it won't come up in any suggestions.

Prompt: Why not pollock?
Tools: []
Reply: Because you took it back — your exact words were "sike, I don't," which retracts the earlier "I really like pollock." Since that's no longer true of you, I don't treat it as something you'd want recommended.

So pollock stays off the list. If you're actually in the mood for it, say the word and I'll note it as current again.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Halibut is my favourite fish. [halibut-favourite-fish-88eb] (2026-10-26T18:13:10Z, nash)
Taken back: I really like pollock. [like-pollock-71c2] — sike, I don't.
No record of: none

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": false, "says_taken_back": true}

## activmem 4
Prompt: I really like pollock.
Tools: []
Reply: Got it — pollock's your thing. I'll keep that in mind.

Prompt: sike, I don't.
Tools: [{'tool': 'memory_revises', 'args': {'new_text': "sike, I don't.", 'old_item_id': 'like-pollock-71c2'}}]
Reply: Done — "I really like pollock" is now taken back and won't be recommended. Pollock is off the list.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Got it — halibut is your favourite. I've noted that, and I'll leave pollock off any recommendations since you've taken that back.

Prompt: What seafood should I order tonight?
Tools: []
Reply: Based on what I have on record, halibut is your favourite fish — so that's my pick for tonight. A simple pan-sear or grill with butter and lemon, or halibut fish and chips if you want something heartier.

I've left pollock off the list entirely, since you took that back.

Prompt: Why not pollock?
Tools: []
Reply: Because you took it back. You'd said you really like pollock, then followed with "sike, I don't" — so it's off the table.

Halibut is still the one that stands.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Halibut is my favourite fish. [halibut-favourite-fish-88eb] (2026-10-26T18:16:02Z, nash)
Taken back: I really like pollock. [like-pollock-71c2] — sike, I don't.
No record of: none

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": false, "says_taken_back": true}

## activmem 5
Prompt: I really like pollock.
Tools: []
Reply: Got it — noted that you really like pollock. (Painter Jackson Pollock, or the fish? Either way, I'll keep it in mind.)

Is there something you'd like to do with that — track down a print, a recipe, or something else?

Prompt: sike, I don't.
Tools: []
Reply: I tried to record that as taking back your pollock preference, but the memory tool refused: it says the fragment "sike, I don't." doesn't authorize revising `like-pollock-71c2`, and nothing connects the two.

So nothing was changed — the record still shows "I really like pollock" as current.

Could you confirm explicitly what you're taking back? For example: "Take back my pollock preference" or tell me what "it" refers to.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Got it — halibut is your favourite fish. Noted alongside your liking for pollock (no conflict there, so nothing taken back).

If you'd like, I can recommend a halibut recipe or two, or keep both in mind next time fish comes up.

Prompt: What seafood should I order tonight?
Tools: []
Reply: Your memory says halibut is your favourite fish, and there's nothing taken back on that — so halibut is the easy pick tonight. Order it.

Prompt: Why not pollock?
Tools: []
Reply: No reason on record. Nothing in your memory says anything about pollock — no dislike, no restriction, no note of any kind. The only thing stored right now is a filler entry, so if there was a favourite-fish note earlier, it's not in front of me anymore.

So pollock is fine to order; the only thing I can say is that I don't have any taste preference for you on file for it.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Halibut is my favourite fish. [halibut-favourite-fish-88eb] (2026-10-26T18:19:15Z, nash)
Taken back: none
No record of: none

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": false, "says_taken_back": false}

## control 1
Prompt: I really like pollock.
Tools: []
Reply: Noted — is that Pollock the painter or the fish? Happy to keep it in mind either way.

Prompt: sike, I don't.
Tools: []
Reply: Nothing to revise — there's no recorded item under Current to take back, so there's nothing to strike. If you meant something specific from earlier, tell me what it was and I'll correct the record.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Got it — halibut is your favourite fish. I've noted it. (That's a new fact rather than a change to anything you said before, so I haven't overwritten any earlier note.)

Prompt: What seafood should I order tonight?
Tools: []
Reply: Since halibut is your favourite fish, that's the easy pick: **order the halibut.**

A couple of ways to make the most of it:

- **If it's a fish-and-chips or casual place** — halibut and chips, ideally beer-battered. It's the classic and usually worth the upcharge over cod or haddock.
- **If it's a nicer restaurant** — look for it pan-seared or roasted with a light sauce (brown butter, lemon-caper, or a mild salsa verde). Halibut is lean and mild, so it takes well to butter and acid without being buried.
- **If it's a sushi menu** — halibut (hirame) is excellent as nigiri or in a light usuzukuri prep.

One thing to watch: halibut is often the priciest thing on the menu, and some spots quietly substitute cheaper flounder or cod. If the price looks suspiciously low, it's worth asking.

Want me to narrow it down if you tell me where you're ordering from?

Prompt: Why not pollock?
Tools: []
Reply: Fair point — you *do* like pollock, so it's a perfectly good order. Nothing's wrong with it; I just led with halibut because you've called it your favourite fish, so it edged out the rest.

Where pollock actually wins:

- **Value** — it's typically much cheaper than halibut for a very similar mild, white, flaky texture.
- **Fried** — pollock is the classic fish for fish and chips and for fast-food fish sandwiches; it holds up well in batter.
- **Fish tacos, fish pie, fish cakes** — pollock is ideal for anything where the fish gets broken up or sauced, since you're not paying a premium for a pristine fillet.

Where halibut still edges it out:

- **Eaten plainly** — pan-seared, roasted, or grilled, halibut has a firmer, meatier flake that stands on its own. Pollock is softer and more prone to falling apart.
- **Sushi/raw** — halibut (hirame) is a proper sushi fish; pollock isn't.

So: if tonight is a casual, fried, or sauced-and-mixed dish, order the pollock and save the money. If it's a nice fillet you want to taste on its own, go halibut.

Which kind of place are you ordering from? That'd settle it.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Got it — halibut is your favourite fish. I've noted it. (That's a new fact rather than a change to anything you said before, so I haven't overwritten any earlier note.) [got-halibut-favourite-7197] (2026-10-26T18:22:12Z, vera)
Taken back: none
No record of: seafood, order, tonight

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": true, "says_taken_back": false}

## control 2
Prompt: I really like pollock.
Tools: []
Reply: Noted. Quick check so I file it right: do you mean Jackson Pollock, the painter, or the fish?

If it's the artist — the drip paintings, *Autumn Rhythm*/*Number 1A*, or the earlier "she-wolf"/mural work? If it's the fish, I'd guess eating it. Either way, I'll remember the preference; just tell me which "Pollock" you mean.

Prompt: sike, I don't.
Tools: []
Reply: Nothing to revise — there's no Current line on record to take back, so I've made no memory change. If you meant to retract something specific, tell me what it was and I'll update it.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Noted — halibut is your favourite fish.

I'm not logging this as a revision, since it isn't taking anything back: there's no prior "favourite fish" on record for it to replace. Your existing note that you really like pollock (`like-pollock-71c2`) stays as-is — liking pollock and having halibut as your favourite aren't in conflict, so nothing is overwritten.

So the current picture is:

- **Favourite fish:** halibut (new)
- **Also likes:** pollock (`like-pollock-71c2`)
- **Taken back:** none

If you meant for halibut to *replace* pollock rather than just be a new favourite, say so and I'll record that as a revision instead.

Prompt: What seafood should I order tonight?
Tools: []
Reply: Based on what I have on record for you:

- **Halibut** — your favourite fish, so that's my top pick for tonight.
- **Pollock** — you also like it, a good fallback if halibut isn't on the menu or is pricey.

Nothing under "Taken back," and I have no other seafood notes, so beyond those two I'm just guessing. If you want, tell me the restaurant/menu and I'll pick from what's actually available.

Prompt: Why not pollock?
Tools: []
Reply: Nothing against pollock — it's on the list, and I did suggest it as your fallback. I only ranked it second because **halibut** is your favourite fish, so that's the one I'd lead with for a special order like tonight.

Pollock is a perfectly good pick, especially if you want something cheaper or halibut isn't available. There's no "taken back" note on pollock — you really like it and that still stands.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Noted — halibut is your favourite fish.

I'm not logging this as a revision, since it isn't taking anything back: there's no prior "favourite fish" on record for it to replace. Your existing note that you really like pollock (`like-pollock-71c2`) stays as-is — liking pollock and having halibut as your favourite aren't in conflict, so nothing is overwritten.

So the current picture is:

- **Favourite fish:** halibut (new)
- **Also likes:** pollock (`like-pollock-71c2`)
- **Taken back:** none

If you meant for halibut to *replace* pollock rather than just be a new favourite, say so and I'll record that as a revision instead. [noted-halibut-favourite-d729] (2026-10-26T18:25:19Z, vera)
Taken back: none
No record of: seafood, order, tonight

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": true, "says_taken_back": false}

## control 3
Prompt: I really like pollock.
Tools: []
Reply: Noted — Pollock it is. I'll keep that in mind.

What are we working on?

Prompt: sike, I don't.
Tools: []
Reply: There's nothing on record to take back — no current memory item exists, so I've made no changes. If you had a specific fact in mind, tell me what it was and I'll correct the record.

Prompt: Halibut is my favourite fish.
Tools: [{'tool': 'memory_revises', 'args': {'new_text': 'Halibut is my favourite fish.', 'old_item_id': 'noted-pollock-ll-cc1f'}}]
Reply: Got it — updating my notes: halibut is your favourite fish, superseding the earlier pollock note. Thanks for the correction.

I don't have a task queued up yet — what would you like to work on?

Prompt: What seafood should I order tonight?
Tools: []
Reply: Halibut — that's the only seafood preference I have on record for you, and it's your favourite fish. So if it's on the menu, that's my pick.

I don't have anything else stored about seafood, restaurants, or tonight's plans, so beyond that you're on your own. Want me to note anything about the place you're ordering from?

Prompt: Why not pollock?
Tools: []
Reply: Fair question, and my earlier answer was too quick. Here's the honest reasoning:

My notes had two entries — first that you like pollock, then a later note that halibut supersedes it as your *favourite* fish. I treated "favourite" as replacing pollock entirely, which over-read it. Liking pollock and having halibut as your favourite aren't in conflict; both can be true at once. There's no record of you ever taking back the pollock note.

So: no good reason not to order pollock. If you want it tonight, order it.

One thing I want to check rather than assume — did you mean to demote halibut, or just point out that pollock's still in play? Right now I'm reading it as the latter, so I haven't changed anything in my notes.

- Order pollock — nothing's stopping you; my earlier steer to halibut was based on a bad inference.
- Keep both — halibut favourite, pollock a solid like. No note change needed.
- Actually, pollock's the favourite now — say the word and I'll revise the record.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Got it — updating my notes: halibut is your favourite fish, superseding the earlier pollock note. Thanks for the correction.

I don't have a task queued up yet — what would you like to work on? [got-updating-notes-c899] (2026-10-26T18:28:22Z, vera)
Taken back: none
No record of: seafood, order, tonight

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": true, "says_taken_back": false}

## control 4
Prompt: I really like pollock.
Tools: []
Reply: Noted — Pollock it is. (The painter, I assume, though I'm happy to hear about the fish too.)

Prompt: sike, I don't.
Tools: []
Reply: There's nothing for me to revise — no current or taken-back memory items exist in this session, so "sike, I don't" doesn't attach to anything. If you meant to retract something, tell me what it was and I'll handle it then.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Got it — halibut is your favourite fish, noted.

Quick note on the memory side: I did not treat this as a correction, so I left the existing `Pollock it is` line (noted-pollock-painter-b5c7) untouched. That entry is about Pollock the *painter*, and nothing in it records a fish preference, so "halibut is my favourite fish" is a new fact rather than a take-back or a change to something you already said. If you actually meant halibut *replaces* a fish favourite you'd stated before, tell me and I'll record the revision — but as it stands there's no prior fish entry to revise ("No record of: halibut, favourite").

Prompt: What seafood should I order tonight?
Tools: []
Reply: Halibut — it's your favourite fish, so that's the safe order.

Prompt: Why not pollock?
Tools: []
Reply: No reason against it — you really like pollock too, so it's a perfectly good order. Halibut just happens to be your favourite, which is why I led with it. Order either, or get the halibut if you want the top pick.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Got it — halibut is your favourite fish, noted.

Quick note on the memory side: I did not treat this as a correction, so I left the existing `Pollock it is` line (noted-pollock-painter-b5c7) untouched. That entry is about Pollock the *painter*, and nothing in it records a fish preference, so "halibut is my favourite fish" is a new fact rather than a take-back or a change to something you already said. If you actually meant halibut *replaces* a fish favourite you'd stated before, tell me and I'll record the revision — but as it stands there's no prior fish entry to revise ("No record of: halibut, favourite"). [got-halibut-favourite-b5f7] (2026-10-26T18:31:31Z, vera)
Taken back: none
No record of: seafood, order, tonight

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": false, "says_taken_back": false}

## control 5
Prompt: I really like pollock.
Tools: []
Reply: Noted — I'll remember that you're a Pollock fan. Is it Jackson Pollock's paintings, or the fish you're thinking of?

Prompt: sike, I don't.
Tools: []
Reply: There's nothing for me to take back — I have no current memory recorded, and nothing under "Taken back" or matching "sike." So there's no prior statement of yours for this to reverse.

If you meant to retract something specific, tell me what it was (or it needs to be on the Current line with an item id), and I'll record the revision.

Prompt: Halibut is my favourite fish.
Tools: []
Reply: Got it — halibut is your favourite fish. I've noted that.

Prompt: What seafood should I order tonight?
Tools: []
Reply: Since halibut is your favourite fish, that's the easy pick — the halibut. 

If you want a second option in case the restaurant's out of it, just tell me what's on the menu and I'll suggest a pairing.

Prompt: Why not pollock?
Tools: []
Reply: No reason at all — pollock's a great shout, and you've told me you really like it. Both are mild white fish, so they're interchangeable for most preparations.

The only reason I led with halibut is that it's your favourite, so it's the default when nothing else is steering the choice. But "favourite" doesn't mean "only" — pollock is a solid pick, and usually the cheaper one, so it's arguably the better everyday order.

If the menu has both tonight: pollock. Save the halibut for when you want to treat yourself.

Injected:
Items under "Taken back" are no longer true and must not be recommended.
Current: Got it — halibut is your favourite fish. I've noted that. [got-halibut-favourite-e592] (2026-10-26T18:34:27Z, vera)
Taken back: none
No record of: seafood, order, tonight

Judge C: {"recommends_pollock": false, "picks_halibut": true}
Judge D: {"recommends_pollock": true, "says_taken_back": false}
