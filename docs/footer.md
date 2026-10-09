---
title: "Footer layout"
description: "Choose what shows under the composer, and where."
---

# Footer layout

The rows under the composer hold small items: the live status, the key hints,
subscription limits, the folder and branch, the activity strip, and the pane
controls. Run `/settings`, then Footer layout, to choose
which of them show and which slot each one sits in. The composer itself does
not change.

Each item shows whenever it has something to show: the activity strip during
a turn, the limits when the provider reports them. The live status reads
`ready` while idle and names the phase during a turn. The key hints read
`Ctrl+P commands · Ctrl+X h keys` while idle and `Ctrl+X h keys` during a
turn.

The screen draws an example footer, a crow working in `~/crow-nest` on the
`plunder` branch, so every item has something to show while you place it.
The real footer under the composer changes with each edit too. Escape saves
the layout for this home.

## The grid

The footer has three rows of four numbered slots:

```text
 1 live status     2 limits          3 ·               4 key hints
 5 folder          6 branch          7 pane controls   8 activity strip
 9 ·              10 ·              11 ·              12 ·
```

Each item sits in one slot, and `·` is an empty slot. A row spreads its items
from edge to edge with even gaps, so there is no stray space on either side.
A row with one item keeps it on the left for slots in the first two columns,
and on the right for the last two.

When a row runs short, the item in the highest-numbered slot shortens first,
then steps aside. Slot 1 holds on longest. The key hints never step aside,
so the way to the keys card is always visible.

The activity strip keeps its space while it has nothing to show, so the
items beside it do not move when a turn starts or ends.

## Keys

| Key | On a slot |
| --- | --- |
| Arrows | Move between slots. Up from the first row reaches Preview; Down from the last row reaches Reset to default. |
| Enter | Pick up the item in this slot. |
| Space | Hide or show the item. The key hints always show. |
| Escape | Save and go back to Settings. |

On Preview, Left and Right flip the example between idle and mid-turn. On
Reset to default, Enter puts the standard layout back.

## Move an item

Enter picks the item up, and the title reads `Footer layout › moving
<item>`. The arrows carry it from slot to slot. Landing on a filled slot
swaps the two items. Enter or Space puts it down, and Escape puts everything
back where it was.

The example is drawn as it looks in an 80-column terminal. Putting an item
down, or hiding or showing one, is refused if it would leave an item out
there, and the hint line says
`won't fit at 80 columns`. A narrower terminal may still shorten or drop the
items in the highest slots.

If the item you pick up has nothing to show in the current preview, such as
the activity strip while idle, the preview flips to the state where it shows.

## Edit the file

The layout is saved under `footer_layout` in the home's `tui.json`. Only a
layout that differs from the default is written:

```json
{
    "footer_layout": {
        "rows": [
            ["status", "limits", null, "keys"],
            ["folder", null, "panes", "activity"],
            [null, "branch", null, null]
        ],
        "hidden": ["panes"]
    }
}
```

`rows` holds three rows of four slots, and `null` is an empty slot. An item
the file does not place goes back to its default slot, or the first empty
one. A field Vera cannot read falls back to its default, and a broken
`footer_layout` never stops Vera from starting.
