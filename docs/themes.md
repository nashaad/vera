---
title: "Themes"
description: "Pick a TUI theme or write your own."
---

Run `/theme` in the TUI to pick a theme. Moving through the list previews each
theme. Enter keeps it; Escape puts the previous one back. The choice is saved
for this home.

System takes its colors from your terminal. Every other theme is a fixed
palette.

## Your own themes

Put your themes in `tui-themes.json` at the root of your home, next to
`config.json`:

```json
{
  "themes": {
    "my-dusk": {
      "label": "My Dusk",
      "description": "purple, softer text",
      "extends": "vera-purple",
      "text": "#CFCBE0",
      "accent": "#B79CFF"
    }
  }
}
```

- The key (`my-dusk`) is the theme's name. `label` is what the picker shows,
  and defaults to the name. `description` is optional.
- `extends` copies another theme, then your colors replace its colors. It can
  name a built-in theme or one defined earlier in the same file.
- Without `extends`, a theme lists every color.
- A theme with a built-in's name replaces that built-in in the list.
- `system` and `orng` are reserved. Orng is the fallback theme and cannot be
  changed, though your themes can extend it.

Colors are written as `#RRGGBB`. The color names are `accent`, `text`, `muted`,
`notice`, `danger`, `success`, `critical`, `secondary`, `focus`, `inactive`,
`activityTrail`, `dangerSurface`, `diffAdded`, `diffRemoved`, `code`,
`background`, `panel`, `element`, `input`, `menu`, and `selectionText`.
`chrome` is `"plain"` or `"norton"`. `hud` optionally recolors the HUD with
`background`, `border`, `text`, `muted`, `accent`, `notice`, `success`, and
`auto`.

Vera reads the file at start and each time `/theme` opens, so an edit shows up
the next time you open the picker. A theme with a mistake is left out, and the
transcript names the file, the theme, and what is wrong with it. The other
themes still load. If the theme you picked is left out, Vera uses Orng until
you fix it.
