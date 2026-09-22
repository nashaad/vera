---
title: "Models, favorites, and defaults"
description: "Choose a model for your conversation, save favorites, and assign models to other jobs."
---

# Models, favorites, and defaults

Vera can use models from any connected provider. You choose the model for the
conversation you're working in. Favorites make models easier to find; defaults
choose models for jobs such as compaction and delegated work.

| To do this | Open |
| --- | --- |
| Change this conversation's model | `/model` |
| Browse every model, with prices and scores | `/models` |
| Save models for quick access | Favorites, in `/models` |
| Assign models to other jobs | Defaults, in `/models` |
| Connect a provider | Providers, in `/models`, or Ctrl+E there |

Switch model changes what runs next and writes nothing that outlives the
conversation, except a favorite. `/models` is the opposite: it browses,
favorites, assigns, and connects, and never changes what runs next.

These choices are independent. Selecting a model does not favorite it, and
removing a favorite does not clear a default assignment.

## Choose a model

<div data-widget="screen-steps" data-steps="switch-model"></div>

1. Enter `/model` to open **Switch model**.
2. Type a model name. Search includes connected models outside your favorites.
3. Use Up/Down to highlight a model, then press Enter.
4. If the model offers reasoning effort levels, choose one to finish.

The list opens as Favorites, then Recent from this conversation, then every
connected model grouped by provider. Typing drops the grouping and ranks one
list by how well each name matches. Ctrl+F adds or removes the highlighted
favorite; that is the only thing this dialog writes to disk.

Switch model has no filters, sort, scores, prices, or details panel. Those are
in `/models`.

In a conversation, the selection applies to its next request. From Home, it
opens a conversation. The composer footer shows the current model and effort.

You can also open Switch model from Ctrl+P, or press Ctrl+X, release Ctrl,
and press M. Escape cancels that shortcut without changing your draft.

## Browse every model

`/models` opens the browse page: a searchable list of models with Filter and
sort, Connect provider, and Manage models under it. Nothing here changes the
model for your next request.

### Filter and sort

Browse starts with Favorites unless you saved another collection. To see every
connected model, open **Filter and sort** and choose **All connected**.
Ctrl+G switches between these two collections.

Filters narrow results by provider, availability, known price, image support,
and intelligence score. They also apply to searches. Clearing the search
returns to the selected collection; it does not clear filters.

Enter on a toggle, such as view, an on/off filter, variants, or **Clear
filters**, changes that row and leaves the menu open. Choosing a value from
Show, Sort, or Provider returns you to Filter and sort on the row you changed.

The **Intelligence cutoff** slider runs from Any to Smarter. Left and Right
change it. Enter returns to the model list and keeps the cutoff; Escape
returns and keeps it too. A positive cutoff also hides models without scores,
including favorites. If a model is missing, check the cutoff and other filters
before reconnecting its provider.

Older and extra variants are normally hidden unless favorited or found by
search. Turn on variants in Filter and sort to browse them. **Clear filters**
keeps your search, view, sort order, and favorites.

### Compare prices and capabilities

Choose **Detailed** view in Filter and sort to add WA Score, input price,
output price, and status columns when the terminal is wide enough. When there
is room for both, a details panel sits beside those columns. If the columns
need the width, the panel is omitted. A narrower terminal keeps facts in the
list, including image support, verification, and the exact model ID.

Prices are dollars per million tokens. Unknown scores and prices show `?`.
An unknown price is not zero. WA Score, when known, is a rating from blind
comparisons of responses.
**Cheapest first** sorts within each provider using three input tokens for
every output token, with unknown prices last. Other orders are A to Z and,
within Favorites, your saved favorite order.

Vera saves the collection, view, and sort for the next time you open the picker.

## Save favorites

Open Favorites from `/models`, highlight a model, and press Enter to add or
remove it. Ctrl+S does the same on a highlighted model anywhere in the model
page, and Ctrl+F does it in Switch model.

Connected providers start with a few favorites already saved, so the list is
not empty before you curate it.

Favoriting saves a shortcut. It does not switch the conversation or make a
verification request. Removing a favorite keeps its verification results and
any default assignments.

### Rename or verify a favorite

In Favorites, Ctrl+R changes the highlighted model's display name. Leave the
name empty to restore its catalog label. Ctrl+Y tests whether the model can
answer; it also works on connected models you have not favorited.

For bulk checks, choose **Verify favorites** from the command palette. Tab
switches between unverified favorites and all favorites. Choose all of them or
one provider, then press Enter to start.

Verification makes real requests and can incur provider charges. Results show
whether each check passed or failed. Escape returns to the previous screen
while those checks continue.

## Assign defaults

Open Defaults from `/models` to assign connected models to snappy, eco, extra, classifier,
compaction, and subagents. A model does not have to be a favorite to appear here.

New assignments require successful verification and permission to use the
model. Vera warns before a verification request that may cost money. A failed
check or canceled assignment leaves the previous value in place. Escape
cancels the assignment, though an already-started check may still finish.

Assigning a default leaves your conversation model unchanged. Subagents use
an ordered list of allowed models and an optional fallback to the spawning
conversation's model. See [Agents and delegated work](agents.md).

## Adjust agent and access together

Press Shift+Tab from the composer, or choose **Dial strip** from Ctrl+P, to
open the quick controls.

| Key | Action |
| --- | --- |
| Tab or Shift+Tab | Move between Agent and Access. |
| Up/Down | Move between the two. |
| Left/Right | Choose a value. |
| Enter | Apply both values together. |
| Escape | Cancel the changes. |

Access offers readonly, ask, and auto. Unavailable choices are skipped.

Model and effort are not here. Use `/model` and `/effort`. The composer footer
shows all four values whether or not the quick controls are open.

## Set reasoning effort

`/effort` lists the levels the current model supports, each with a line saying
what it is for. `/effort <level>` sets one directly. Levels differ by model,
and not every model has an off setting.

Switching models keeps your effort level when the new model also supports it.
You are asked to choose again only when it does not.

## Refresh or recover a connection

Choose **Refresh model catalog** from Manage models (Ctrl+K on the browse page)
to reload connected catalogs. A brief overlay reports catalogs refreshed, new
models, and any failures. A model that has disappeared from its provider is
marked unavailable and cannot be selected.
To change credentials or endpoints, use [Configure providers](first-run-setup.md).

Vera retries transient request failures up to twice. Missing credentials or
provider credit need your attention and stop immediately. Malformed tool
arguments can also be retried when no tool could have run. If retries fail,
Vera keeps the last partial response and shows the error.

### Configure an overload fallback

A `fallback` entry in the home configuration can name a backup on the same
provider:

```json
{
    "fallback": {
        "model": "your-backup-model",
        "after_failures": 3
    }
}
```

`after_failures` accepts 1, 2, or 3 consecutive rate-limit or server failures.
Once selected, the backup stays active for the rest of the turn. This setting
is separate from the Subagents default list.

### Use a local model

[Connect a running local server](first-run-setup.md#connect-a-local-server),
then choose its model in Switch model. Vera does not install or download models.

A successful connection does not establish the model's context window or
reasoning controls. If the server omits those facts, context occupancy and
effort can remain unknown until configured or supplied by a supported mapping.
Thinking controls vary by server; do not assume every local model has the same
effort levels.

## Keyboard reference

The footer shows the action for the focused control. Typing or pasting from
any picker control moves into Search.

| Key | In Switch model | In the model page |
| --- | --- | --- |
| Enter on a model | Select it for the conversation. | Add or remove the favorite. |
| Ctrl+F | Add or remove the favorite. | |
| Ctrl+S | | Add or remove the favorite. |
| Ctrl+R | | Rename the highlighted model. |
| Ctrl+Y | | Verify the highlighted model. |
| Ctrl+E | | Configure providers. |
| Ctrl+K | | Open Manage models for the highlighted model. |
| Ctrl+G | | Toggle Favorites / All connected. |
| Ctrl+D / Ctrl+U | Move half a page down / up. | Move half a page down / up. |
| Space in the list | | Fold or unfold a provider group. |
| Ctrl+A outside Search | | Show or hide extra variants. |
| Tab / Shift+Tab | | Move between controls. |

Switch model has no controls to move between: type to search, Up/Down to move,
Enter to switch. In the model page's Search, Left/Right move the caret and
Space enters a space. Arrows that have no action in the current control move
focus to another control.

Manage models includes **Add/remove favorites**, defaults, refresh, and provider
configuration. Opening its favorites editor does not change membership until
you make a choice there.

## Command-line reference

```sh
vera library list
vera library add "<provider>/<model>"
vera library add "<provider>/<model>" --verify
vera library remove "<provider>/<model>"
vera models refresh
```

Adding without `--verify` saves the reference without contacting the provider.
With `--verify`, Vera saves it only after the required tool-calling check passes.
Refreshing updates a running host's catalog, or the cache for the next host.
No TUI restart is needed.

The older `vera shortlist` spelling remains an alias for `vera library`.

The model page's collection, view, and sort persist under `model_picker` in
the home's `tui.json`.
