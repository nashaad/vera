import { useEffect } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/astro';
import { ActivityMark } from './activity-mark';
import { Content } from './content';
import { TerminalReplay } from './terminal-replay';
import { backdropSvg, chromeDefsSvg, veraStageSvg } from './vera-stage';
import '../styles/homepage.css';

interface HomepageProps {
    pathname: string;
    description?: string;
    html: string;
    draft: boolean;
}

interface RestingPoint {
    x: number;
    y: number;
    turn: number;
    scale: number;
    opacity: number;
}

function randomPoint(): RestingPoint {
    const pick = (low: number, high: number): number => low + Math.random() * (high - low);
    return { x: pick(-12, 12), y: pick(-10, 10), turn: pick(-8, 8), scale: pick(0.95, 1.12), opacity: pick(0.75, 1.1) };
}

// The colour masses wander on a timer and when the pointer moves, never on scroll.
function useWanderingBackdrop(): void {
    useEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const masses = [...document.querySelectorAll<SVGElement>('.home-backdrop .wash')];
        if (masses.length === 0) return;
        function wander(): void {
            for (const mass of masses) {
                const p = randomPoint();
                mass.style.transform = `translate(${p.x}%, ${p.y}%) rotate(${p.turn}deg) scale(${p.scale})`;
                mass.style.opacity = String(p.opacity);
            }
        }
        let lastMove = 0;
        function onPointerMove(): void {
            const now = performance.now();
            if (now - lastMove < 4000) return;
            lastMove = now;
            wander();
        }
        const timer = window.setInterval(wander, 14000);
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('pointermove', onPointerMove);
        };
    }, []);
}

export function Homepage({ pathname, html, draft }: HomepageProps) {
    useWanderingBackdrop();
    return (
        <RootProvider pathname={pathname} theme={{ defaultTheme: 'dark' }}>
            <div className="home-backdrop" aria-hidden="true" dangerouslySetInnerHTML={{ __html: backdropSvg }} />
            <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: chromeDefsSvg }} />
            <div className="vera-home">
                <header className="home-header">
                    <a className="home-wordmark" href={pathname}>vera</a>
                    <nav aria-label="Site">
                        <a href="/manual/">Manual</a>
                        <a href="#install">Install</a>
                        <a href="https://github.com/nashaad/vera">Source</a>
                        <a href="https://discord.gg/8svqyjdhS8">Discord</a>
                        <a href="https://corvines.com">Corvine Systems</a>
                    </nav>
                </header>
                <main className="home-grid">
                    <section className="home-row home-hero" aria-labelledby="home-heading">
                        <div className="home-cell home-hero-text">
                            {draft && <p className="home-preview-label">Homepage preview</p>}
                            <h1 id="home-heading">A durable, open agent runtime and harness.</h1>
                            <p className="home-lede">Use the SDK library and workflow to script in Python and build your application.</p>
                            <ul className="home-points">
                                <li>Work with an agent in your terminal.</li>
                                <li>Write workflows in plain Python. Steps retry, branch, pick up after a crash, and wait for a person when they need one.</li>
                                <li>Add extensions, or use the SDK to build your own agents.</li>
                            </ul>
                            <p className="home-public">Being built in public.</p>
                            <div className="home-actions">
                                <a className="home-button primary" href="/getting-started/">Get started</a>
                                <a className="home-button" href="/manual/">Read the manual</a>
                            </div>
                        </div>
                        <div className="home-cell stage" dangerouslySetInnerHTML={{ __html: veraStageSvg }} />
                    </section>
                    <section className="home-row home-demo" id="in-use" aria-labelledby="demo-heading">
                        <div className="home-cell home-demo-player">
                            <TerminalReplay recording="conversation" appearanceControls={false} ambient />
                        </div>
                        <div className="home-cell home-demo-text">
                            <h2 id="demo-heading">Inside a conversation</h2>
                            <p>A recorded session: an answer, then switching models and filtering them by score.</p>
                            <ActivityMark />
                        </div>
                    </section>
                    <div className="home-details prose prose-neutral dark:prose-invert"><Content html={html} /></div>
                </main>
                <footer className="home-footer">
                    <span className="home-footer-links">
                        <a href="https://corvines.com">Corvine Systems</a>
                        <a href="https://nashaad.com">nashaad.com</a>
                    </span>
                    {draft ? <span>Preview. Excluded from the public site.</span> : <a href="/manual/">Manual</a>}
                </footer>
            </div>
        </RootProvider>
    );
}
