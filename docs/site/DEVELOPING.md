# Working on the manual

Run `bun run dev:manual` from the worktree root. The site reads the Markdown
files directly from `docs/`.

## Preview pages

Add `draft: true` to a page's frontmatter to put it in the local Preview
section. Draft pages are excluded from the public build's routes, navigation,
search index, and Markdown downloads. Recording routes are generated only
for visible pages that use them. Keep draft recordings in `src/recordings/`,
not `public/`, which is copied into every build.

Remove `draft: true` when a page should be public, and link it in `docs/index.md`
to choose its sidebar section and order.

## Build commands

From this directory:

- `bun run check` checks types and templates.
- `bun run build` writes the public site to `dist/`.
- `bun run build:preview` includes drafts and writes to `dist-preview/`.

Deploy `dist/` for the public site. `dist-preview/` includes draft content.
