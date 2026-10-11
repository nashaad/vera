# vera.artifacts

An included extension that gives agents markdown artifacts you can comment on.
It adds four tools and an Artifacts page in the annex.

- `artifact_write` creates or replaces an artifact by name.
- `artifact_edit` replaces one exact passage.
- `artifact_read` reads an artifact and counts its open comments. Without a
  name it lists the session's artifacts.
- `artifact_comments` lists comments, or closes or deletes one by id.

`artifact_read` declares `extension.storage.read`, which runs without a
prompt in ask, auto and readonly mode. `artifact_write`, `artifact_edit` and
`artifact_comments` declare `extension.storage.write`, so ask and auto mode
run them without a prompt. The manifest lists all four in `unreviewed_tools`.

Every artifact belongs to the session that wrote it. `artifact_write` replies
with the artifact's page address, and the transcript shows it as a notice.
Markdown images with an https address show as a picture, or as a player for
audio and video files. A fenced block marked `html embed` runs its HTML and
scripts in a sandboxed frame, so an artifact can hold its own player or chart.
The frame cannot read the page or call its API. Any agent with these tools can
use them; the plan example writes its plan as an artifact named `plan`.

## The Artifacts page

Open the annex and pick Artifacts from the page menu. The list shows every
artifact, newest first. An artifact page shows the markdown with comments in
the right margin.

- Hover a block and click the comment button to start a comment. Cmd+Enter
  posts it; Escape cancels.
- Resolve, Reopen and Delete appear when you hover a comment.
- The comment button in the header hides or shows comments; its menu picks
  open comments, all comments, or none.

A comment does not start a turn. The agent sees it the next time it calls
`artifact_read` or `artifact_comments`. When the text a comment was left on
changes, the comment is marked Outdated. Resolved comments fold into one line.

Tick Send to Vera in the comment box to also send the comment to the session
that owns the artifact. It arrives in that session's inbox from
`vera.artifacts` and starts a turn without an admission prompt. A sent comment
shows Sent to Vera. If the session is not open, the comment is saved and the
box says it was not sent.

The page refreshes every second, so edits from the agent appear while you
read.

## Try it

Ask for an artifact, for example "write an artifact named raid with the crew's
plan for the crow's treasure", then open the link in the transcript. Disable
the extension with `/extension disable vera.artifacts`.

## Test

```bash
bun test test/extensions/artifacts.test.ts
```
