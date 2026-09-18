---
title: "Connect and manage providers"
description: "Connect an API, subscription, or local server and make its models available."
---

# Connect and manage providers

Open **Configure providers** from Ctrl+P to add a connection, refresh its
models, or change its credentials. You can also choose **Connect a provider**
on Home.

## Connect an API provider

1. Choose **Add provider**.
2. Enter the provider name, endpoint, and API key. Known providers prefill the
   endpoint. Custom providers also let you choose a protocol and whether a key
   is required.
3. Press Enter to save. Vera reads the catalog and reports how many models it
   found.

Endpoints can use HTTP or HTTPS. Connecting a provider makes its catalog
available; it does not select, favorite, verify, or assign a default model.

### Choose a model

Open **Switch model** with `/model`. It lists your favorites, then recent
models, then every connected model. Type to search the whole catalog, highlight
a model, and press Enter. If it offers effort levels, choose one to start the
conversation.

Favorites save models for quick access. You do not need to favorite a model
before selecting it, verifying it, or assigning it as a default. Assigning a
default verifies the model first and can incur provider charges. See
[Models and favorites](models.md).

### If the connection fails

The form keeps your input and names the cause. Check the reported URL, key,
connection, or catalog error, then correct the field and save again. A duplicate
connection or an unsupported URL scheme is also reported here.

## Subscription sign-in

Choose the subscription connection in **Configure providers** and follow the
sign-in instructions in your browser. To sign in again, open the connection's
actions and choose **Reconnect**.

Saved authentication lives in `~/.vera/machine/auth.json`. Manage it through
the provider screen.

## Connect a local server

Start the model server and install its models before connecting Vera. The
built-in local connection uses `http://127.0.0.1:11434` unless `OLLAMA_HOST`
selects another endpoint. For another server, add its endpoint through
**Add provider**.

The legacy local installation wizard is separate from this connection form.
Selecting a model changes the current conversation. Use **Defaults** to choose
models for later conversations.

## Manage connections

**Configure providers** groups connections under Subscriptions, API keys,
Local, and Added in config. Status distinguishes a catalog or model that
answered, a stored key, and a provider that has not answered.

It is a separate screen, including when opened from Switch model. Escape
returns to the screen you came from.

### Refresh models

Choose **Refresh providers** below the groups to read every connected catalog.
To refresh one connection, press Enter on its row and choose **Refresh**.
The result appears on the provider screen; your search and highlighted row
stay in place.

### Edit a connection

Press Enter on a provider and choose **Edit** to change its endpoint or
credentials. Fixed subscription connections offer **Reconnect** instead.

Escape from Edit returns to the actions menu. Escape again returns to the
same provider list and search. Endpoint and refresh shortcuts also work.

### Forget credentials

**Forget credentials** asks for confirmation and shows how many library
entries are affected. It removes the provider's models, unsets affected
defaults, and clears conversation selections using that provider.

Credentials supplied through the host environment must be unset there.

## Keys supplied by the environment

Supported built-in connections can read exported keys, including
`OPENROUTER_API_KEY` and `CEREBRAS_API_KEY`. Export the key before starting the
host. A running host retains its own environment.

A key entered through the provider screen is stored by Vera, outside project
configuration.
