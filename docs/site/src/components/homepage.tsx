import { ArrowDown, ArrowRight } from 'lucide-react';
import { RootProvider } from 'fumadocs-ui/provider/astro';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Content } from './content';
import { TerminalReplay } from './terminal-replay';
import '../styles/homepage.css';

interface HomepageProps {
    pathname: string;
    description?: string;
    html: string;
    draft: boolean;
}

export function Homepage({ pathname, description, html, draft }: HomepageProps) {
    return (
        <RootProvider pathname={pathname} theme={{ defaultTheme: 'dark' }}>
            <HomeLayout
                className="vera-home"
                nav={{ title: 'Vera', url: pathname }}
                searchToggle={{ enabled: false }}
                links={[
                    { text: 'Manual', url: '/' },
                    { text: 'Halcyon', url: '/halcyon/' },
                    { text: 'Install', url: '#install' },
                    { type: 'button', text: 'Get started', url: '/getting-started/' },
                ]}
            >
                <section className="home-intro" aria-labelledby="home-heading">
                    {draft && <p className="home-preview-label">Homepage preview</p>}
                    <h1 id="home-heading">Vera is an<br /><span>agent harness.</span></h1>
                    <p className="home-description">{description}</p>
                    <div className="home-actions">
                        <a className="home-primary" href="/getting-started/">Get started <ArrowRight size={17} aria-hidden="true" /></a>
                        <a className="home-secondary" href="/">Read the manual</a>
                    </div>
                    <a className="home-scroll" href="#in-use">See Vera in use <ArrowDown size={14} aria-hidden="true" /></a>
                </section>
                <section className="home-demo" id="in-use" aria-labelledby="demo-heading">
                    <div className="home-demo-caption">
                        <h2 id="demo-heading">Inside a conversation</h2>
                        <span>Choose and compare models</span>
                    </div>
                    <TerminalReplay recording="model-picker" appearanceControls={false} />
                    <p className="home-recording-note">A recorded Vera session. Play, pause, or move through the recording.</p>
                </section>
                <div className="home-details prose prose-neutral dark:prose-invert"><Content html={html} /></div>
                <footer className="home-footer">
                    <a href="/">Vera documentation</a>
                    {draft && <span>Preview. Excluded from the public site.</span>}
                </footer>
            </HomeLayout>
        </RootProvider>
    );
}
