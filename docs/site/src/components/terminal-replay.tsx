import { useEffect, useRef, useState } from 'react';
import type { Player } from 'asciinema-player';
import 'asciinema-player/dist/bundle/asciinema-player.css';

interface TerminalReplayProps {
    recording: 'conversation';
    appearanceControls?: boolean;
    // Plays on its own and loops, with no player controls.
    ambient?: boolean;
}

type Appearance = 'site' | 'recorded';

export function TerminalReplay({ recording, appearanceControls = true, ambient = false }: TerminalReplayProps) {
    const container = useRef<HTMLDivElement>(null);
    const player = useRef<Player | null>(null);
    const [appearance, setAppearance] = useState<Appearance>('site');
    const [error, setError] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let disposed = false;
        let instance: Player | undefined;
        setReady(false);
        setError(false);
        async function mount() {
            try {
                const { create } = await import('asciinema-player');
                if (disposed || !container.current) return;
                instance = create(`/recordings/${recording}.cast`, container.current, {
                    autoPlay: ambient,
                    loop: ambient,
                    controls: !ambient,
                    fit: 'width',
                    poster: 'npt:10.1',
                    terminalFontFamily: appearance === 'site'
                        ? '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
                        : 'Menlo, monospace',
                    terminalLineHeight: appearance === 'site' ? 1.5 : 1.25,
                    theme: 'asciinema',
                });
                player.current = instance;
                setReady(true);
            } catch (cause) {
                console.error('Unable to load terminal replay', cause);
                if (!disposed) setError(true);
            }
        }
        void mount();
        return () => {
            disposed = true;
            instance?.dispose();
            player.current = null;
        };
    }, [recording, appearance, ambient]);

    async function replay() {
        try {
            await player.current?.seek(0);
            await player.current?.play();
        } catch {
            setError(true);
        }
    }

    return (
        <section className="manual-replay not-prose" aria-label="Vera terminal recording">
            {appearanceControls && <div className="manual-replay-controls">
                <button type="button" aria-pressed={appearance === 'site'} onClick={() => setAppearance('site')}>Site style</button>
                <button type="button" aria-pressed={appearance === 'recorded'} onClick={() => setAppearance('recorded')}>Recorded appearance</button>
                <button type="button" disabled={!ready} onClick={() => void replay()}>Replay from start</button>
            </div>}
            <div className="manual-replay-frame vera-panel">
                <div className="manual-replay-scroll"><div ref={container} className="manual-replay-player" /></div>
            </div>
            {error && <p role="alert">The recording could not load. Reload the page to try again.</p>}
        </section>
    );
}
