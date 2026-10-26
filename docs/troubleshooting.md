---
title: "Troubleshooting"
description: "Check a connection or configuration problem and choose the relevant recovery action."
---

# Troubleshooting

Start with the error Vera reports. `/diagnostics` inspects the current
conversation or host, `/doctor` checks the runtime, and `/context` reports
context usage without sending a model request.

## The client lost its host

If the TUI says disconnected, press Ctrl+P and choose **Reconnect host**. Vera
makes one automatic restart attempt after a dropped connection; Reconnect host
provides explicit recovery if that attempt did not succeed. It is not a slash
command.

Reconnect host uses the host associated with this Vera home. It can replace the
process and return to the same conversation without changing the installed
build. Choosing it authorizes that recovery; there is no second prompt.

### What recovery does

| Host state | Result |
| --- | --- |
| Missing or dead | Start a host and reattach the conversation. |
| Process alive but not answering | Force-stop that process, start a host, and reattach. |
| Healthy and idle | Ask it to shut down, replace it, and reattach. |
| Healthy and busy | Refuse replacement while other work is using it. |

A busy refusal protects active work. The composer stays usable. Let that work
finish, or use the deliberate shutdown controls in
[Development instances and process cleanup](runtime-and-worktrees.md).

A socket file existing on disk does not prove the host is answering.

## Provider models look stale

Open Configure providers and refresh the affected provider. Check the endpoint
if the refresh fails. Restarting the TUI alone does not refresh provider state
held by the host.

See [Manage connections](first-run-setup.md#manage-connections) for refresh,
credentials, and sign-in controls.

## A configured extension is missing

Open `/extensions` and inspect its status. A missing environment credential
can prevent it from loading. See
[Extension credentials](extension-credentials.md#diagnose-a-missing-variable).

## A model request failed

When a request fails and retrying cannot help, the turn ends with a **MODEL
REQUEST FAILED** error. It names the model, says what went wrong, quotes the
provider's own message when there is one, and ends with a **Fix** line:

```text
× MODEL REQUEST FAILED
  The model, custom/crow-main, rejected the request: The crow dropped the
  request in a storm.
  Fix: pick another model with /model. The Vera report in /diagnostics has
  the full error.
```

A spent usage limit shows when it resets. The error is saved with the
conversation, so a reopened conversation shows it too. The provider's full
response is in `/diagnostics`: open the **Vera** report and look under
**MODEL FAILURES**.

## Capture a model failure

Use `/failure-report` for a shareable report of recorded model failures.
Failed compactions are recorded too, with the reason the summary did not land.
This is a model-failure report, not a general bug-report system.

Session files, request captures, and classifier logs can contain private
conversation and project material. Review them before sharing.

Logs under `~/.vera/runtime/logs/`, including request captures and classifier
logs, are deleted once they are more than seven days old. The host checks when
it starts and once a day. To keep them longer, set a whole number of days in
`config.json`, for example `"log_max_age_days": 30`. Copy a log elsewhere to
keep it for good. A running sidecar's log is never deleted. Session files in
`runtime/sessions/` are not logs and are never deleted this way.
