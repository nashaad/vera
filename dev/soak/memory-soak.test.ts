import { expect, test } from "bun:test";
import { runSoak } from "./run.ts";

test("headless host native and JS heap memory do not climb after the warm-up turns", async () => {
    const result = await runSoak({ turns: 120, warmup: 20, speed: 5, maxGrowthBytes: 2 * 1024 * 1024, maxHeapGrowthBytes: 4 * 1024 * 1024 });
    expect(result.errors).toEqual([]);
    expect(result.growthBytes).toBeLessThanOrEqual(result.options.maxGrowthBytes);
    expect(result.heapGrowthBytes).toBeLessThanOrEqual(result.options.maxHeapGrowthBytes);
}, 420_000);
