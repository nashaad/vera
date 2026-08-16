import { expect, test } from "bun:test";

import {
    describeModelSlots,
    type VeraModelSlotsConfig,
} from "../../src/config/model-slots.ts";
import type { VeraModelCatalogConfig } from "../../src/config/model-catalog.ts";
import { tuiSlotListing } from "../../clients/tui/state.ts";

const CATALOG: VeraModelCatalogConfig = {
    models: [
        { name: "big", provider: "openrouter", model: "big-1", reasoning_effort: "high" },
        { name: "small", provider: "cerebras", model: "small-1" },
    ],
    model_routes: { best: ["big"], cheap: ["small"] },
    reviewer_profiles: {},
};

function rows(slots: VeraModelSlotsConfig, reachable?: (name: string) => boolean) {
    return describeModelSlots(
        CATALOG,
        slots,
        reachable === undefined
            ? undefined
            : (entry) => reachable(entry.name),
    );
}

test("an unset job slot reports the intent it inherits", () => {
    const reviewer = rows({ extra: { model_route: "best" } })
        .find((row) => row.slot === "reviewer");
    expect(reviewer?.route).toBeUndefined();
    expect(reviewer?.source).toBe("intent");
    expect(reviewer?.inherits).toBe("extra");
    expect(reviewer?.models.map((model) => model.name)).toEqual(["big"]);
});

test("an unreachable route stays on the row next to its substitute", () => {
    const reviewer = rows(
        { extra: { model_route: "best" }, reviewer: { model_route: "cheap" } },
        (name) => name !== "small",
    ).find((row) => row.slot === "reviewer");
    expect(reviewer?.route).toBe("cheap");
    expect(reviewer?.declared.map((model) => model.name)).toEqual(["small"]);
    expect(reviewer?.source).toBe("intent");
    expect(reviewer?.models.map((model) => model.name)).toEqual(["big"]);
});

test("compaction with nothing bound falls to the session's model", () => {
    const compaction = rows({}).find((row) => row.slot === "compaction");
    expect(compaction?.source).toBe("session");
    expect(compaction?.models).toEqual([]);
});

test("the listing shows the route, the substitute, and the unset rows", () => {
    const listing = tuiSlotListing(rows(
        {
            snappy: { model_route: "cheap" },
            extra: { model_route: "best" },
            reviewer: { model_route: "cheap", label: "critic" },
        },
        (name) => name !== "small",
    ));
    expect(listing).toContain("extra");
    expect(listing).toContain("best · big-1 (high)");
    expect(listing).toContain("critic      cheap unreachable, uses extra");
    expect(listing).toContain("unset, uses the session's model");
    expect(listing).toContain("snappy      cheap unreachable, nothing runs it");
});
