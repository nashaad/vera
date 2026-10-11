# vera-docs

An example extension that gives agents markdown docs you can comment on. It
adds four tools and a Docs page in the annex.

- `doc_write` creates or replaces a doc by name.
- `doc_edit` replaces one exact passage.
- `doc_read` reads a doc and counts its open comments. Without a name it lists
  the session's docs.
- `doc_comments` lists comments, or closes or deletes one by id.

`doc_write`, `doc_edit` and `doc_comments` declare
`extension.storage.write`, so ask and auto mode run them without a prompt.
Every doc belongs to the session that wrote it. `doc_write` replies with the
doc's page address, and the transcript shows it as a notice. Markdown images
with an https address show as a picture, or as a player for audio and video
files. A fenced block marked `html embed` runs its HTML and scripts in a
sandboxed frame, so a doc can hold its own player or chart. The frame cannot
read the page or call its API. Any agent with these tools can use them; the plan example
writes its plan as a doc named `plan`.

## The Docs page

Open the annex and pick Docs from the page menu. The list shows every doc,
newest first. A doc page shows the markdown with comments in the right margin.

- Hover a block and click the comment button to start a comment. Cmd+Enter
  posts it; Escape cancels.
- Resolve, Reopen and Delete appear when you hover a comment.
- The comment button in the header hides or shows comments; its menu picks
  open comments, all comments, or none.

A comment does not start a turn. The agent sees it the next time it calls
`doc_read` or `doc_comments`. When the text a comment was left on changes, the
comment is marked Outdated. Resolved comments fold into one line.

Tick Send to Vera in the comment box to also send the comment to the session
that owns the doc. It arrives in that session's inbox from `example.docs` and
starts a turn without an admission prompt. A sent comment shows Sent to Vera. If the session
is not open, the comment is saved and the box says it was not sent.

The page refreshes every second, so edits from the agent appear while you
read.

## Try the example

```text
/extension install <path>/examples/extensions/docs
```

Then restart the host and client, and ask for a doc, for example "write a doc
named raid with the crew's plan for the crow's treasure".

## Test

```bash
bun test
```
