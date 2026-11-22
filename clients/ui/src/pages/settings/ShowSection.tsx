import { Fragment } from "react";

import type { FlagGroup } from "../../state/desktopFlags.ts";
import { chooseDesktopFlag, useDesktopFlags } from "../../state/useDesktopFlags.ts";
import { Segmented } from "./Segmented.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { SHOW_CHOICE_LABELS, SHOW_GROUP_TITLES, choicesFor, rowsIn } from "./show.ts";

const GROUPS: readonly FlagGroup[] = ["window", "developer"];

export function ShowSection() {
    const flags = useDesktopFlags();
    return (
        <>
            <h1>Show</h1>
            <p className="settings-lede">Choose which parts of the window appear. Auto shows a part once it has something to show. Turning a part off removes its entries from the window; its data and background work stay as they are.</p>
            {GROUPS.map((group) => (
                <Fragment key={group}>
                    <h2 className="settings-sec">{SHOW_GROUP_TITLES[group]}</h2>
                    {rowsIn(group).map(({ key, name, description, spec }) => (
                        <SettingRow key={key} id={`show.${key}`} name={name} description={description}>
                            <Segmented
                                label={name}
                                options={choicesFor(spec)}
                                labels={SHOW_CHOICE_LABELS}
                                value={flags[key]}
                                onChange={(choice) => void chooseDesktopFlag(key, choice)}
                            />
                        </SettingRow>
                    ))}
                </Fragment>
            ))}
        </>
    );
}
