import { saveFeedback } from "../../src/feedback/store.ts";
try {
    await saveFeedback(process.argv[2]!, { kind: "bug", title: "Crow", description: "", source: "terminal" });
    process.exit(0);
} catch {
    process.exit(1);
}
