import { startTui } from "../../clients/tui/main.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";
import { createTuiResumeScenario } from "./tui-resume-child.ts";

installTestProcessGuard();
const scenario = createTuiResumeScenario({ home: process.env.VERA_HOME! });
const listAgents = scenario.dependencies.listAgents!;
const original = scenario.dependencies.client;
let firstReceive = true;
await startTui({
    ...scenario.dependencies,
    client: {
        ...original,
        async receive(signal) {
            if (firstReceive) {
                firstReceive = false;
                return { type: "history", entries: [], seq: 0 };
            }
            return original.receive(signal);
        },
    },
    listAgents: async () => (await listAgents()).map((agent) =>
        agent.id === "current-session-id"
            ? { ...agent, live: true, has_user_content: false }
            : agent
    ),
});
