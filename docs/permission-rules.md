---
title: "Permission modes and rules"
description: "Choose how much Vera may do without asking, and write your own rules."
---

# Permission modes and rules

Every tool call is checked before it runs. The answer is one of four: run it,
ask you, send it to the [classifier](permission-classifier.md), or refuse it.

## Built-in modes

| Mode | What runs without asking | Everything else |
|---|---|---|
| `readonly` | Reads, including shell commands that only read such as `cat` or `git log`, `ask_user`, reading process output, functions an SDK program gave its agent | Refused |
| `ask` | Reads, writes inside the workspace, `git commit`, web searches and page fetches, subagent messages, extensions writing their own data, functions an SDK program gave its agent | Asks you |
| `auto` | Same as `ask` | Goes to the classifier |
| `full_access` | Everything except the recursive `rm` cases below | Refused |

Shell commands that only look run without review in readonly, ask, and auto.
That covers `cd`, `ps`, `du`, `which`, and `hostname -s`, and a read such as
`cat "$FILE"` whose argument comes from a variable. A `for`, `while`, or
`until` loop is judged by the commands inside it. `sed`, `find`, `rg`, `sort`,
and `git` still go to review when an argument comes from a variable, because
the variable could hold a flag that writes.

After `cd`, relative paths are read from the new folder when the target starts
with `/`, `~`, `./`, or `../`. For any other `cd`, such as `cd src` or `cd -`,
later relative paths are not resolved, so a write through one goes to review in
auto and asks in ask. A `cd` that some bash would not run, such as the second
`time` in `time time cd /Users/me/proj/a`, a `cd` after `time -p`, a `cd` in a
`function` body or after `coproc`, or one that ends in `&` and so runs in the
background, is treated the same way: later relative paths are not resolved.

A checkout of the same git repository other than the session's counts as
outside the workspace. With a session in `~/proj`, a write into
`~/proj/.worktrees/fix` is a write outside the workspace, and so is a write into
`~/proj` or into a sibling `~/proj/.worktrees/other` from a session in
`~/proj/.worktrees/fix`. Submodules, nested clones and the worktrees of other
repositories stay inside.

In auto, a write or delete in another worktree of the session's repository
asks you instead of going to the classifier. That covers the file tools and
shell targets such as `printf x > ~/proj/out.txt` or `rm ~/proj/old.txt`. Other writes outside the workspace
still go to the classifier, ask asks for all of them, `full_access` allows and
readonly refuses. A run with nobody to answer, such as `vera -p` or an SDK
agent, refuses a write that asks, so in auto the write does not happen.

Shell write and delete targets are checked where they really land. Vera follows
symlinks in the path, so `printf x > hold/map.txt`, with `hold` linking to a
folder outside the workspace, is a write outside the workspace. Deleting a
symlink is judged by what it points to. A target Vera cannot follow, such as a
symlink loop, goes to review in auto and asks in ask.

In readonly, ask, and auto, the file tools refuse to read a file named `.env`,
`*.pem`, or `id_rsa`. A shell command such as `cat .env` is not caught by this
rule. Stopping a process this conversation started is always allowed.

Shift+Tab switches the current conversation only. `/permissions <mode>`
switches it and also makes that mode your default. For a one-shot run, pass
`--permission-mode <mode>` to `vera -p`. With no default set, the mode is
`auto`.

In every mode, including full access, Vera refuses a recursive `rm` in the
`bash` tool when it targets a filesystem root, your home directory or everything
in it (`~/*`), the workspace or everything in it (`./*`), or a folder above the
workspace. This check runs before the mode, so an Always answer or a Session
grant cannot allow it. Run the deletion yourself if you mean it. The check reads
the command as written, so a target built from a variable or a command
substitution, such as `$HOME`, is not caught.

The check also reads the command inside `bash -c`, `sh -c`, `zsh -c`, `$(...)`,
backticks (including backticks nested inside backticks), `eval`, `exec`,
`env -S`, `xargs` and `find -exec`. Each of these counts as a level of nesting,
like `bash -c`. Shell nested more than four levels deep, such as `bash -c`
inside `bash -c` five times, is refused too, because Vera cannot check what
runs inside it.

Every here-document body and every here-string is read as a shell script,
whichever command receives it, and a here-document body is also read line by
line. So `rm -rf ~` in the body of `cat <<EOF`, or in `grep x <<< 'rm -rf /'`,
is refused, and each body counts as a level of nesting. The command is also
read as if it had no here-documents, so text after a `<<` is checked as
ordinary commands too. Run the deletion yourself if you mean it.

A here-document is refused when its delimiter holds an opening backtick, `$(`,
`${` or `$[` outside single quotes, or a quoted `-` right after `<<`, because
Vera cannot tell where the document ends. The delimiter ends at an unquoted `>`
or `<`, so `cat <<EOF>"$out"` is not refused.

A command whose nested scripts need more checking than a fixed limit is
refused, because Vera cannot check what runs inside them. The limit grows with
the length of the command.

Text after a `#` is read too, because bash can read that `#` as part of a word:
the command is checked once with each `#` as the start of a comment and once as
ordinary text. So a comment that holds `; rm -rf /` or `$(rm -rf /)` is
refused, except after an earlier comment with an unmatched quote, such as
`# don't`, which hides the later one from the second check.

The check sees through the shell's own words that come before a command: `!`,
`time` (with `-p` or `--`), `coproc` (with or without a name), `function` (with
its name), `if`, `while`, `then`, `do`, `{`, `command`, `env`, `exec` and
`eval`. So `time -p rm -rf /`, `coproc { rm -rf /; }`,
`function f { rm -rf /; }` and `! time rm -rf /` are refused. Any of these
words can be followed by an assignment or a redirect and then by another such
word, so `{ 2>/dev/null rm -rf /; }` and `time A=1 rm -rf /` are refused too.
An assignment before a command can be `A=1`, `A+=1` or `A[0]=1`, and a redirect
can name its descriptor with `{name}`, as in `{fd}>x rm -rf /`; the command
after either is checked. A subscript that holds a space, a tab, an operator
such as `;`, `|`, `&` or `(`, or an arithmetic expansion, such as
`A[1 + 1]=x rm -rf /`, is not read as an assignment, and a descriptor with a
subscript, as in `{a[0]}>x`, is not read as a redirect. Both follow the mode.

Bash 3.2 reads `time` after a `case` pattern's `)` as a program and later bash
reads it as a keyword, and bash in POSIX mode does not read `time -p` as the
keyword. The command is checked both ways, and a `cd` after such a `time` is
not trusted. A `#` after a `?`, `*`, `+`, `@` or `!` group, as in `!(true)#`,
is read both as a comment and as part of the word. A backslash and newline
inside `<<`, `<(` or `>(` join the operator, as bash does.

Program wrappers such as `/usr/bin/time`, `nohup`, `sudo` and `nice` are not
followed. `nohup rm -rf /` is not caught by this check and follows the mode.

The check reads only the literal text of the command and of the scripts it
wraps. It does not check code built from variables or command output, such as
`eval "$cmd"` or `eval "$(ssh-agent -s)"`, a script read from a file, or a pipe
into a shell such as `curl ... | sh`; those follow the mode. Commands like
`find . -name '*.tmp' -exec rm {} +` and `xargs rm < list` follow the mode too.

## Answer a prompt

| Key | Effect |
|---|---|
| 1 Allow once | Runs this call. |
| 2 Session | Allows calls like this one for the rest of the conversation. |
| 3 Deny | Refuses this call. |
| 4 Always | Saves an allow rule that applies in every conversation. |

Session and Always describe "calls like this one" as narrowly as Vera can: the
same operation, the same file, or the same shell command name. A prompt from a
subagent offers only Allow once and Deny.

To see or remove what Session and Always granted, open Ctrl+P and choose
**Review granted permissions**.

## Write a custom mode

A custom mode is a named list of rules in Home `config.json`. Here the crow may
read anything and write its log, may never push the stolen charts, and asks
about the rest:

```json
"permission_modes": {
  "crows-nest": {
    "default": "ask",
    "rules": [
      { "when": { "operation": "git.push" }, "then": "deny" },
      { "when": { "verb": "read" }, "then": "allow" },
      { "when": { "verb": "write", "path_scope": "workspace" }, "then": "allow" }
    ]
  }
}
```

Select it with `/permissions crows-nest`.

Each action takes the first rule that matches; if none match, it gets
`default`. When one tool call is several actions (a fetch is both a web
operation and a read of a URL), the strictest answer wins.

A custom mode starts empty. It does not copy the `.env` rule or anything else
from the built-in modes, so add what you want to keep.

### Rule fields

A `when` must name at least one field, and every field it names must match.

| Field | Matches |
|---|---|
| `tool` | A tool name, such as `bash` or `web_fetch`. |
| `verb` | `read`, `write`, `delete`, or `unknown`. |
| `path` | That absolute path or anything under it. |
| `path_glob` | The file name; `*` matches any run of characters. |
| `host` | The website a URL points at, such as `github.com`. `*.github.com` matches its subdomains but not `github.com` itself. |
| `path_scope` | `workspace` or `outside_workspace`. |
| `operation` | An operation such as `git.push`, or a prefix ending in `*` such as `git.*`. |
| `executable` | A shell command name, such as `make`. |

`then` is `allow`, `ask`, `review`, or `deny`. A mode that uses `review`
anywhere needs a `reviewer_profile` naming an entry in `reviewer_profiles`.

Operations you can name: `agent.close`, `agent.inbox`, `agent.message`,
`agent.roster`, `agent.spawn`, `extension.storage.read`,
`extension.storage.write`, `function.call`, `git.clone`, `git.commit`, `git.fetch`,
`git.ls_remote`, `git.pull`, `git.push`, `git.remote_update`, `memory.write`,
`process.kill`, `process.read`, `web.download`, `web.fetch`, `web.search`.

An extension tool that writes only the extension's own data can declare
`permissionOperation: "extension.storage.write"`. Ask and auto run it without
asking, and readonly refuses it. A tool that only reads the extension's own
data can declare `extension.storage.read`, which runs without asking in ask,
auto and readonly. Either one needs the tool's name in the manifest's
`unreviewed_tools` list, and `/extension install` shows that list before you
enable the extension. Installing the extension is the consent.

In auto mode, the first time one of these tools from an extension you
installed runs, the transcript shows a muted line such as "crow.tools ran
shanty_write without review." It shows once per extension in each home.
Extensions included with Vera do not show it. To stop an extension's tools
from running, turn the extension off in `/extensions`.

The other operations above belong to Vera. An extension you install that
declares one of them fails to load, and `/extensions` shows it as `failed`
with the reason once the host has restarted. An extension may name an
operation of its own, such as `crow.shout`; ask asks and auto reviews it.
Once the classifier allows it, auto runs that operation for the rest of the
conversation without review.

> [!WARNING]
> A mistake in any custom mode stops the whole config from loading. Mode names
> use lowercase letters, digits, `-`, and `_`. A custom mode cannot replace a
> built-in one.

### Websites

`host` lets a rule name a website. On shore leave the crow may download
from GitHub without asking, and the navy is refused outright:

```json
"permission_modes": {
  "shore-leave": {
    "default": "ask",
    "rules": [
      { "when": { "host": "royal-navy.example" }, "then": "deny" },
      { "when": { "operation": "web.download", "host": "github.com" }, "then": "allow" },
      { "when": { "operation": "web.download", "host": "*.github.com" }, "then": "allow" },
      { "when": { "verb": "read" }, "then": "allow" }
    ]
  }
}
```

Put a host `deny` before any rule that would allow the same request.
Write international names in their `xn--` form, without a port or path.

A host rule checks the address Vera asked for. A redirect to another site
is not checked again, and shell commands such as `curl` are not covered.
