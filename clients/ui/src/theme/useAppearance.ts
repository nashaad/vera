import { useRef, useSyncExternalStore } from "react";

import { readAppearance, subscribeAppearance, type Appearance } from "./preferences.ts";

// The stored appearance, redrawing the caller when Settings changes it. `readAppearance` builds a new object
// each call, so the last one is kept until a field differs.
export function useAppearance(): Appearance {
    const last = useRef<Appearance | undefined>(undefined);
    const read = (): Appearance => {
        const next = readAppearance();
        const known = last.current;
        const same = known !== undefined && (Object.keys(next) as (keyof Appearance)[]).every((key) => known[key] === next[key]);
        if (known !== undefined && same) return known;
        last.current = next;
        return next;
    };
    return useSyncExternalStore(subscribeAppearance, read);
}
