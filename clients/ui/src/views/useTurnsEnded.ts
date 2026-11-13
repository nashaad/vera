import { useEffect, useRef, useState } from "react";

// Counts the turns that ended while mounted. Views that show files read them again when it moves,
// since a turn is when Vera changes files.
export function useTurnsEnded(running: boolean): number {
    const [ended, setEnded] = useState(0);
    const wasRunning = useRef(running);
    useEffect(() => {
        if (wasRunning.current && !running) setEnded((count) => count + 1);
        wasRunning.current = running;
    }, [running]);
    return ended;
}
