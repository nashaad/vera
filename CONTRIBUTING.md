# Contributing

Thanks for your interest in Vera. For now, contributions are by
invitation, and we hope to open things up more over time. If you'd like
to get involved, say hello on [Discord](https://discord.gg/8svqyjdhS8).

## Before you start

For a new capability or a larger change, we start with a quick chat
before any code. New capabilities usually take the shape of an extension
or an agent, and agreeing on that shape first saves everyone rework.

## Pull requests

- Work on a branch and open a pull request. Changes reach `main` through
  review.
- Run the tests for the area you changed, and `bun run typecheck`. A pull
  request adds no new type errors.
- Fill in the description template in `.github/pull_request_template.md`:
  what changes, why, how you tested it, and what it breaks. For a behavior
  change, show what a user sees before and after.
- We squash-merge pull requests, so your branch commit messages are up
  to you. The final commit gets a one-line conventional title (`feat:`,
  `fix:`, ...).
