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
| Save models for quick access | `/library-model` |
| Assign models to other jobs | `/defaults` |
| Connect a provider | Configure providers from Ctrl+P |

These choices are independent. Selecting a model does not favorite it, and
removing a favorite does not clear a default assignment.

## Choose a model

1. Enter `/model` to open **Switch model**.
2. Type a model name. Search includes connected models outside your favorites.
3. Use Up/Down to highlight a model, then press Enter.
4. If the model offers reasoning effort levels, choose one to finish.

In a conversation, the selection applies to its next request. From Home, it
opens a conversation. The composer status shows the current model and effort.

You can also open Switch model from Ctrl+P, or press Ctrl+X, release Ctrl,
and press M. Escape cancels that shortcut without changing your draft.

### Browse and filter

The picker starts with Favorites unless you saved another collection. To see
every connected model, open **Filter and sort** and choose **All connected**.
Ctrl+G switches between these two collections.

Filters narrow results by provider, availability, known price, image support,
and intelligence score. They also apply to searches. Clearing the search
returns to the selected collection; it does not clear filters.

The **Intelligence cutoff** slider runs from Any to Smarter. A positive cutoff
also hides models without scores, including favorites. If a model is missing,
check the cutoff and other filters before reconnecting its provider.

Older and extra variants are normally hidden unless favorited or found by
search. Turn on variants in Filter and sort to browse them. **Clear filters**
keeps your search, view, sort order, and favorites.

### Compare prices and capabilities

Choose **Detailed** view in Filter and sort to see input and output prices,
status, image support, verification, and the exact model ID. Wider terminals
show a details panel; narrow terminals keep facts in the list.

Prices are dollars per million tokens. An unknown price is not zero.
**Cheapest first** sorts within each provider using three input tokens for
every output token, with unknown prices last. Other orders are A to Z and,
within Favorites, your saved favorite order.

Vera saves the collection, view, and sort for the next time you open the picker.

## Save favorites

Open `/library-model`, highlight a model, and press Enter to add or remove it.
You can also press Ctrl+S on a highlighted model in either Favorites or
Switch model.

Favoriting saves a shortcut. It does not switch the conversation or make a
verification request. Removing a favorite keeps its verification results and
any default assignments.

### Rename or verify a favorite

In Favorites, Ctrl+R changes the highlighted model's display name. Leave the
name empty to restore its catalog label. Ctrl+Y tests whether the model can
answer; it also works on connected models you have not favorited.

For bulk checks, choose **Verify library models** from the command palette.
Tab switches between unverified favorites and all favorites. Choose the whole
library or one provider, then press Enter to start.

Verification makes real requests and can incur provider charges. Results show
whether each check passed or failed. Escape returns to the previous screen
while those checks continue.

## Assign defaults

Open `/defaults` to assign connected models to snappy, eco, extra, classifier,
compaction, and subagents. A model does not have to be a favorite to appear here.

New assignments require successful verification and permission to use the
model. Vera warns before a verification request that may cost money. A failed
check or canceled assignment leaves the previous value in place. Escape
cancels the assignment, though an already-started check may still finish.

Assigning a default leaves your conversation model unchanged. Subagents use
an ordered list of allowed models and an optional fallback to the spawning
conversation's model. See [Agents and delegated work](agents.md).

## Adjust model, effort, and access together

Press Shift+Tab from the composer, or choose **Dial strip** from Ctrl+P, to
open the quick controls.

| Key | Action |
| --- | --- |
| Tab or Shift+Tab | Move between Effort, Access, Model, and Agent. |
| Up/Down in Model | Choose a model. |
| Left/Right in other controls | Choose a value. |
| Enter | Apply the selected values together. |
| Escape | Cancel the changes. |

The model list contains the current model, recent models from this
conversation, and favorites. Choose **All models** for the full picker. That
opens Switch model without applying changes made in the quick controls.

Access offers readonly, ask, and auto. Unavailable choices are skipped.
Reasoning effort depends on the model; not every model supports the same
levels or an off setting.

## Refresh or recover a connection

Press Ctrl+R in Switch model to refresh connected catalogs. A model that has
disappeared from its provider is marked unavailable and cannot be selected.
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

| Key | In Switch model | In Favorites |
| --- | --- | --- |
| Enter on a model | Select it for the conversation. | Add or remove the favorite. |
| Ctrl+S | Add or remove the favorite. | Add or remove the favorite. |
| Ctrl+R | Refresh connected catalogs. | Rename the highlighted model. |
| Ctrl+Y | | Verify the highlighted model. |
| Ctrl+K | Open Manage models for the highlighted model. | |
| Ctrl+G | Toggle Favorites / All connected. | |
| Ctrl+D / Ctrl+U | Move half a page down / up. | Move half a page down / up. |
| Space in the list | Fold or unfold a provider group. | Fold or unfold a provider group. |
| Ctrl+A outside Search | Show or hide extra variants. | Show or hide extra variants. |
| Tab / Shift+Tab | Move between controls. | Move between Search and the list. |

In Search, Left/Right move the caret and Space enters a space. In the model
list, Up/Down move between models. Arrows that have no action in the current
control move focus to another control.

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
The TUI accepts `/library` and `/shortlist` as aliases for `/library-model`.

Quick-control limits live under `model_picker` in the home's `tui.json`:
`hudModels` accepts 1 to 20 (default 10), and `hudRecents` accepts 0 to 20
(default 5). The All models action does not count toward the limit.
