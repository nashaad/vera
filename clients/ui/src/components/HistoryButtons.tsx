import { NAVIGATION_COMMANDS } from "../commands/navigation-commands.ts";
import { useRouter } from "../pages/router.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { shortcutLabel } from "../workbench/hints.ts";
import { ArrowLeftIcon, ArrowRightIcon } from "./Icons.tsx";

function label(title: string, command: string): string {
    const hint = shortcutLabel(command, window.veraDesktop?.platform ?? "");
    return hint === "" ? title : `${title} (${hint})`;
}

export function HistoryButtons() {
    const { run } = useWorkbench();
    const { canBack, canForward } = useRouter();
    return (
        <>
            <button
                type="button"
                className="header-button"
                aria-label="Back"
                title={label("Back", NAVIGATION_COMMANDS.back)}
                data-history="back"
                disabled={!canBack}
                onClick={() => run(NAVIGATION_COMMANDS.back)}
            >
                <ArrowLeftIcon />
            </button>
            <button
                type="button"
                className="header-button"
                aria-label="Forward"
                title={label("Forward", NAVIGATION_COMMANDS.forward)}
                data-history="forward"
                disabled={!canForward}
                onClick={() => run(NAVIGATION_COMMANDS.forward)}
            >
                <ArrowRightIcon />
            </button>
        </>
    );
}
