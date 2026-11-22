---
title: "Connect and manage providers"
description: "Connect an API, subscription, or local server and make its models available."
---

# Connect and manage providers

In the window, choose a provider on first run, enter its key or sign in in the
browser, then search for a model and choose **Check and use**. The back arrow
and Escape return to the previous screen, or close setup from the provider list.
Open the same window later from Settings > Providers or the Models browser. A
provider setup request can open it from the conversation. Settings > Providers
lists connected providers and connections to add. Select a connected provider to
manage its credential, or choose **Forget** to remove the connection. Settings >
Models searches and refreshes connected catalogs and controls which models appear
in the model picker.

In the terminal, open **Configure providers** from Ctrl+P to add a connection, refresh its
models, or change its credentials. You can also choose **Connect a provider**
on Home.

## Connect an API provider

<div data-widget="screen-steps" data-steps="add-provider"></div>

1. Choose **Add provider**.
2. Enter the provider name, endpoint, and API key. Known providers prefill the
   endpoint. Custom providers also let you choose a protocol and whether a key
   is required.
3. Press Enter to save. Vera reads the catalog and reports how many models it
   found.

Endpoints can use HTTP or HTTPS. Connecting a provider makes its catalog
available; it does not select, favorite, verify, or assign a default model.

### Choose a model

Open **Switch model** with `/model`. With no favorites, it opens on All
connected; once favorites exist, it opens on the saved scope. In Favorites, it
lists your current model, favorites, and recent models. Click the header scope
chip or press Ctrl+G to switch between Favorites and All connected. Search
follows the selected scope. Highlight a model and press Enter. If it offers
effort levels, choose one to start the conversation. A model that verifies
successfully during initial setup becomes the default for new conversations
when the starter model is unused and no other default has been assigned.

Favorites save models for quick access. You do not need to favorite a model
before selecting it, verifying it, or assigning it as a default. See
[Models and favorites](models.md).

### If the connection fails

The form keeps your input and names the cause. Check the reported URL, key,
connection, or catalog error, then correct the field and save again. A duplicate
connection or an unsupported URL scheme is also reported here.

## Subscription sign-in

Choose the subscription connection in **Configure providers** and follow the
sign-in instructions in your browser. The list stays open and the row reads
`signing in…` until the browser finishes. Vera prints the sign-in link while
it waits, so you can open it yourself if no browser appears. To sign in again,
open the connection's actions and choose **Reconnect**.

Saved authentication lives in `~/.vera/machine/auth.json`. Manage it through
the provider screen.

## Connect a local server

Start the model server and install its models before connecting Vera. The
built-in local connection uses `http://127.0.0.1:11434` unless `OLLAMA_HOST`
selects another endpoint. For another server, add its endpoint through
**Add provider**.

> Connecting Ollama this way works, but it may not give the best experience
> with Vera. Ollama expects to configure the coding tools it supports itself,
> through `ollama launch`, and a plain API connection does not get that setup.
>
Outrider's guided setup is experimental. It is hidden from provider setup
unless `experimental.outrider_onboarding` is `true` in Home config. Enable it
through `/configure` if you want Vera to offer the Outrider installer and model
download. An existing home with Outrider selected keeps showing it.

Selecting a model changes the current conversation. Use **Defaults** to choose
models for later conversations.

## Manage connections

**Configure providers** groups connections under Subscriptions, API keys,
Local, and Added in config. Status distinguishes a catalog or model that
answered, a stored key, and `unverified`, which means no model has passed
verification. Opening the list does not test the provider.

It is a separate screen, including when opened from Switch model. Escape
returns to the screen you came from.

### Refresh models

Choose **Refresh providers** below the groups to read every connected catalog.
To refresh one connection, press Enter on its row and choose **Refresh**.
The result appears as an overlay above the dialog that types the message
quickly, then a tick. Escape still belongs to the dialog, so the overlay
clears after a few seconds. Another overlay waits its turn. Your search
and highlighted row stay in place.

### Edit a connection

Press Enter on a provider and choose **Edit** to change its endpoint or
credentials. Fixed subscription connections offer **Reconnect** instead.

Escape from Edit returns to the actions menu. Escape again returns to the
same provider list and search. Endpoint and refresh shortcuts also work.

A provider Vera ships, such as OpenRouter or DeepSeek, cannot be declared
again under `providers` in `config.json`; Vera refuses to load that file. Use
Edit to send a shipped provider's requests to another URL.

### Turn a provider off and on

Turning a provider off keeps its connection and settings but stops using it.
Vera skips its discovery, refresh, and daily catalog checks, and its models do
not appear in the picker. Sessions already running on its models finish. Turn
it on again to read its catalog and use it again. If that read fails, Vera
says so and keeps the saved list.

In the window, choose **Turn off** beside **Forget** on the provider's card.
In the terminal, press Enter on the provider and choose **Turn off**, or press
Ctrl+Shift+O on its row. The row shows `Off` while it is off.

Vera refuses to turn off the provider that supplies the default model, one an
assignment names, or one that is not connected. A connection supplied by the
environment is turned off through the provider screen; remove its key from
`machine/env` only when you also want to forget it.

### Forget credentials

**Forget credentials** asks for confirmation and shows how many library
entries are affected. It removes the provider's models, unsets affected
defaults, and clears conversation selections using that provider. Forgetting
a provider that is off also clears that off state.

Credentials supplied through the host environment must be removed from
`machine/env` in the Vera home.

## Keys supplied by the environment

Supported built-in connections can read keys from the host environment,
including `OPENROUTER_API_KEY` and `CEREBRAS_API_KEY`. The host's environment is
`machine/env` in the Vera home, not the shell you launch from. The first host
start copies every exported `*_API_KEY` into that file; after that, add a key
to the file and restart the host. See
[Where the host runs and what it sees](runtime-and-worktrees.md#where-the-host-runs-and-what-it-sees).

A key entered through the provider screen is stored by Vera, outside project
configuration.
