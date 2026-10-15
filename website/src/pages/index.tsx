// The landing page (docs/docs-overhaul-plan.md §6). Every claim here is shipped, or labeled: see website/STYLE.md.
// Media ids are literals, so the docs build checks them (plugins/media); unpublished ones show as placeholders.
// Budgets: the hero poster is the LCP element, media have their size before they load (no layout shift), clips only
// load and play when in view.
import React, {useId, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useGlobalData from '@docusaurus/useGlobalData';
import Shot from '@site/src/components/Shot';
import Clip from '@site/src/components/Clip';
import StatusBadge from '@site/src/components/StatusBadge';
import ReleaseNoteHighlights from '@site/src/components/ReleaseNoteHighlights';
import styles from './index.module.css';

const GITHUB = 'https://github.com/Samsung/qaboard';

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8 0 3.2.9.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"
      />
    </svg>
  );
}

function SectionHeader({eyebrow, title, children}: {eyebrow?: string; title: string; children?: ReactNode}) {
  return (
    <div className={styles.sectionHeader}>
      {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children && <p className={styles.sectionLead}>{children}</p>}
    </div>
  );
}

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={clsx('container', styles.heroInner)}>
        <div className={styles.heroText}>
          <p className={styles.eyebrow}>Results review for algorithm teams</p>
          <h1 className={styles.heroTitle}>
            Tests tell you it runs. <span className={styles.heroAccent}>QA-Board shows you it&apos;s better.</span>
          </h1>
          <p className={styles.heroLead}>
            Every commit runs on your test set. QA-Board puts its outputs next to the reference&apos;s (images, plots,
            flame graphs, logs and metrics) so your team sees what changed, agrees it&apos;s better, and ships it.
          </p>
          <p className={styles.heroTags}>Self-hosted · git-native · built for heavy data</p>
          <div className={styles.ctas}>
            <Link className="button button--primary button--lg" to="/docs/get-started/quickstart">
              Run it locally
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/get-started/tutorial">
              Get started
            </Link>
            <Link className={styles.githubLink} href={GITHUB}>
              <GitHubIcon />
              Star on GitHub
            </Link>
          </div>
        </div>
        <div className={styles.heroMedia}>
          <Clip id="landing/hero" priority caption="" />
        </div>
      </div>
    </header>
  );
}

const PROOF = [
  {title: 'Open source', text: 'Apache 2.0, on GitHub'},
  {title: 'Self-hosted', text: 'Your results stay on your network'},
  {title: 'Since 2018', text: 'Born at Samsung Israel R&D Center'},
  {title: '~50 projects', text: 'In production there, on the central quality platform'},
];

function ProofStrip() {
  return (
    <section className={styles.proof} aria-label="About QA-Board">
      <ul className={clsx('container', styles.proofList)}>
        {PROOF.map(({title, text}) => (
          <li key={title} className={styles.proofItem}>
            <strong>{title}</strong>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PAINS = [
  'A script that renders an HTML page of images, and an output folder per run that nobody cleans up.',
  'Metrics pasted into a spreadsheet, a week after someone ran them.',
  'Screenshots in a chat thread, to argue which version looks better.',
  'A dashboard someone maintains on weekends, for one project.',
];

function InHouse() {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader title="You already built half of this">
          Every algorithm team ends up with its own tools to look at results. They fit, at first.
        </SectionHeader>
        <ul className={styles.painList}>
          {PAINS.map(pain => (
            <li key={pain} className={styles.pain}>
              {pain}
            </li>
          ))}
        </ul>
        <p className={styles.painAnswer}>
          QA-Board is what those tools become after years of use on dozens of projects: one place where each
          commit&apos;s outputs and metrics sit next to the reference&apos;s, for everyone on the team.
        </p>
      </div>
    </section>
  );
}

type Step = {name: string; title: string; text: ReactNode; link: string; linkLabel: string; media: ReactNode; experimental?: boolean};

const STEPS: Step[] = [
  {
    name: 'Run',
    title: 'Run your code on your test set',
    text: (
      <>
        Wrap your code with <code>qa</code> and run it on a batch of inputs: on your computer, on a cluster (LSF, Dask,
        Celery) or in CI on every push.
      </>
    ),
    link: '/docs/get-started/tutorial',
    linkLabel: 'Put your project on QA-Board',
    media: <Clip id="cli/batch" caption="" />,
  },
  {
    name: 'Compare',
    title: 'Compare every commit with a reference',
    text: 'Each commit against the reference branch or a milestone: every metric, run by run, green when it got better and red when it got worse.',
    link: '/docs/user-guide/commit-page',
    linkLabel: 'The commit page',
    media: <Clip id="commit/compare-tour" caption="" />,
  },
  {
    name: 'Look',
    title: 'Look at the outputs themselves',
    text: 'Images side by side with synced zoom, a perceptual diff and pixel values. Plots overlaid, flame graphs diffed, logs, text and videos.',
    link: '/docs/user-guide/comparing-results',
    linkLabel: 'Comparing results',
    media: <Clip id="commit/image-diff" caption="" />,
  },
  {
    name: 'Find',
    title: 'Find the commit that changed it',
    text: 'History follows a metric across commits, input by input. Hover along the line to see each commit’s outputs.',
    link: '/docs/user-guide/history-and-dashboards',
    linkLabel: 'History',
    media: <Clip id="history/find-regression" caption="" />,
  },
  {
    name: 'Tune',
    title: 'Tune parameters from the browser',
    text: 'Start parameter sweeps or automated tuning from the web app, then see each parameter’s effect and the trade-offs in the Tuning Analysis view.',
    link: '/docs/tuning-from-the-webapp',
    linkLabel: 'Tuning from the web app',
    media: <Clip id="tuning/launch-to-analysis" caption="" />,
  },
  {
    name: 'Gate',
    title: 'Fail CI when quality regresses',
    text: (
      <>
        <code>qa gate</code> checks a commit against rules on your metrics, for changes made by people or by coding
        agents. Experimental: it may change without notice.
      </>
    ),
    link: '/docs/quality-gate',
    linkLabel: 'The quality gate',
    media: <Clip id="cli/gate" caption="" />,
    experimental: true,
  },
];

// Tabs with the keyboard: arrows move between them, Home/End to the ends (WAI-ARIA tabs pattern, automatic activation)
function Loop() {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const select = (index: number) => {
    const next = (index + STEPS.length) % STEPS.length;
    setSelected(next);
    tabs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, number> = {ArrowRight: selected + 1, ArrowDown: selected + 1, ArrowLeft: selected - 1, ArrowUp: selected - 1, Home: 0, End: STEPS.length - 1};
    if (event.key in moves) {
      event.preventDefault();
      select(moves[event.key]);
    }
  };
  const step = STEPS[selected];
  return (
    <section className={clsx(styles.section, styles.sectionAlt)}>
      <div className="container">
        <SectionHeader eyebrow="The loop" title="Run, compare, look, find, tune, gate">
          The same review loop for every algorithm: camera pipelines, models, servers, embedded code.
        </SectionHeader>
        <div className={styles.loop}>
          <div className={styles.loopTabs} role="tablist" aria-label="The review loop" onKeyDown={onKeyDown}>
            {STEPS.map((s, index) => (
              <button
                key={s.name}
                ref={el => {
                  tabs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${index}`}
                aria-selected={index === selected}
                aria-controls={`${id}-panel`}
                tabIndex={index === selected ? 0 : -1}
                className={clsx(styles.loopTab, index === selected && styles.loopTabSelected)}
                onClick={() => setSelected(index)}>
                <span className={styles.loopNumber} aria-hidden="true">
                  {index + 1}
                </span>
                <span className={styles.loopName}>{s.name}</span>
                {s.experimental && <span className={styles.loopExperimental}>Experimental</span>}
              </button>
            ))}
          </div>
          <div className={styles.loopPanel} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${selected}`}>
            <div className={styles.loopText}>
              <h3 className={styles.loopTitle}>
                {step.title} {step.experimental && <StatusBadge status="experimental" />}
              </h3>
              <p>{step.text}</p>
              <Link to={step.link}>{step.linkLabel} →</Link>
            </div>
            {/* Only the selected step's clip is in the page: the others load when picked */}
            <div className={styles.loopMedia} key={step.name}>
              {step.media}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const USE_CASES = [
  {
    audience: 'Camera, ISP, imaging',
    title: 'Image quality',
    text: 'A denoiser wins PSNR but adds halos: synced zoom, Image Diff, deep zoom on 113 MP images, every pipeline stage.',
    to: '/docs/use-cases/image-quality',
  },
  {
    audience: 'Performance engineering',
    title: 'Serving latency',
    text: 'A cache saves CPU and takes p99 from milliseconds to seconds: latency distributions, flame graph diffs, History, a tuning frontier.',
    to: '/docs/use-cases/serving-latency',
  },
  {
    audience: 'Computer vision, ML',
    title: 'Model evaluation',
    text: 'An int8 detector loses small objects: metrics per class and slice, PR curves over the reference, automated tuning.',
    to: '/docs/use-cases/detection-eval',
  },
  {
    audience: 'Embedded, HW/SW co-design',
    title: 'Bit accuracy',
    text: 'Check that a change left every output file identical, before you hand a model over to a hardware team.',
    to: '/docs/bit-accuracy',
  },
  {
    audience: 'Robotics, perception',
    title: 'Trajectories and 3D',
    text: '6DoF trajectories against ground truth, point clouds and videos played in sync with the reference.',
    to: '/docs/visualizations#available-file-viewers',
  },
];

function UseCases() {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader eyebrow="Use cases" title="For outputs that pass/fail tests can't judge">
          Each use case follows a demo project: the problem, the workflow, and the configuration that produces what you
          see.
        </SectionHeader>
        <ul className={styles.cards}>
          {USE_CASES.map(({audience, title, text, to}) => (
            <li key={title} className={styles.card}>
              <span className={styles.cardAudience}>{audience}</span>
              <h3 className={styles.cardTitle}>
                <Link to={to} className={styles.cardLink}>
                  {title}
                </Link>
              </h3>
              <p className={styles.cardText}>{text}</p>
            </li>
          ))}
        </ul>
        <p className={styles.sectionMore}>
          <Link to="/docs/use-cases">All use cases →</Link>
        </p>
      </div>
    </section>
  );
}

// Tiles about 370 px wide: the landing/* shots are 16:10 crops made for them (docs-media/shots/landing.spec.ts)
type Polish = {title: string; text: string; media: ReactNode};

const POLISH: Polish[] = [
  {title: 'Deep zoom', text: 'Images over 100 MP load tile by tile, from the whole image down to single pixels.', media: <Clip id="landing/deep-zoom" caption="" />},
  {title: 'Image Diff', text: 'A perceptual diff with a threshold: only what really changed stands out.', media: <Shot id="commit/image-perceptual-diff" caption="" />},
  {title: 'Pixel values', text: 'Hover a pixel to read its values in both images, with a crosshair on the other.', media: <Shot id="landing/pixel-values" caption="" />},
  {title: 'Histograms', text: 'Select a region to compare its histograms, new against reference.', media: <Shot id="commit/roi-histograms" caption="" />},
  {title: 'Regions of interest', text: 'Jump to preset regions, or to where the images differ most.', media: <Shot id="commit/auto-roi" caption="" />},
  {title: 'Filters', text: 'Brightness, contrast and gamma on every image at once, to see into the shadows.', media: <Shot id="commit/image-filters" caption="" />},
  {title: 'Every stage', text: 'Sliders over a pipeline’s stages or a video’s frames, synced across runs.', media: <Clip id="landing/every-stage" caption="" />},
  {title: 'Flame graph diffs', text: 'The functions that got slower in red, the faster ones in blue, the new ones in orange.', media: <Shot id="commit/flame-diff" caption="" />},
  {title: 'Plot overlays', text: 'Your Plotly figures, with the reference drawn dashed on the same axes.', media: <Shot id="commit/plotly-overlay" caption="" />},
  {title: 'Bit accuracy', text: 'Only the output files that changed: click one to diff it with the reference.', media: <Clip id="landing/bit-accuracy" caption="" />},
  {title: 'Live logs', text: 'Follow a running log, count its errors, jump to the next one.', media: <Clip id="logs/live-tail" caption="" />},
  {title: 'File browser', text: 'Every run’s folder in the browser, driven from the keyboard.', media: <Clip id="files/keyboard" caption="" />},
];

function PolishGrid() {
  return (
    <section className={clsx(styles.section, styles.sectionAlt)}>
      <div className="container">
        <SectionHeader eyebrow="The details" title="Polish you'd never build in-house">
          Years of daily use on dozens of projects, in the web app you get on day one.
        </SectionHeader>
        <ul className={styles.polishGrid}>
          {POLISH.map(({title, text, media}) => (
            <li key={title} className={styles.polishItem}>
              <div className={styles.polishMedia}>{media}</div>
              <h3 className={styles.polishTitle}>{title}</h3>
              <p className={styles.polishText}>{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const STACK = [
  {title: 'Your code', items: ['Python', 'Any executable: C++, shell...'], to: '/docs/running-your-code'},
  {title: 'Git and CI', items: ['GitHub and GitLab webhooks', 'GitHub Actions, GitLab CI, Jenkins', 'CircleCI, Travis CI...'], to: '/docs/ci-integration'},
  {title: 'Runners', items: ['Local processes', 'LSF', 'Dask', 'Celery'], to: '/docs/batches-running-on-multiple-inputs'},
  {title: 'Servers', items: ['Docker Compose', 'Kubernetes (Helm)', 'Air-gapped installs'], to: '/docs/deploy'},
  {title: 'Sign-in', items: ['Local accounts', 'LDAP', 'SAML'], to: '/docs/backend-admin/user-management'},
  {title: 'Storage', items: ['A shared folder (NFS, SMB...)', 'Mounted at the same path everywhere'], to: '/docs/storage/where-is-the-data'},
];

function FitsYourStack() {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader eyebrow="Integrations" title="Fits your stack">
          QA-Board wraps the code you have, where it runs today. It doesn&apos;t need to be the entrypoint of your build or
          your CI.
        </SectionHeader>
        <ul className={styles.stackGrid}>
          {STACK.map(({title, items, to}) => (
            <li key={title} className={styles.stackItem}>
              <h3 className={styles.stackTitle}>
                <Link to={to}>{title}</Link>
              </h3>
              <ul className={styles.stackList}>
                {items.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const ROADMAP = [
  {
    status: 'next',
    title: 'N-way comparisons',
    text: 'Pick N commits, batches or tuning runs: outputs in a grid with synced zoom, one metrics column per run.',
    to: '/docs/roadmap#n-way-comparisons',
  },
  {
    status: 'next',
    title: 'HTTP upload of outputs',
    text: 'Save results from GitHub-hosted runners, laptops off the VPN and pods without a shared volume.',
    to: '/docs/roadmap#http-upload-of-outputs',
  },
  {
    status: 'next',
    title: 'An MCP server',
    text: 'Coding agents read results, Metrics Diffs and image crops, and review their changes like people do.',
    to: '/docs/roadmap#an-mcp-server-read-only-first',
  },
];

function Roadmap() {
  return (
    <section className={clsx(styles.section, styles.sectionAlt)}>
      <div className="container">
        <SectionHeader eyebrow="Roadmap" title="Where we're going" />
        <ul className={clsx(styles.cards, styles.cardsThree)}>
          {ROADMAP.map(({status, title, text, to}) => (
            <li key={title} className={styles.card}>
              <StatusBadge status={status} />
              <h3 className={styles.cardTitle}>
                <Link to={to} className={styles.cardLink}>
                  {title}
                </Link>
              </h3>
              <p className={styles.cardText}>{text}</p>
            </li>
          ))}
        </ul>
        <p className={styles.sectionMore}>
          <Link to="/docs/roadmap">The whole roadmap →</Link>
        </p>
      </div>
    </section>
  );
}

type LatestNote = {
  title: string;
  date: string;
  permalink: string;
  frontMatter: {description?: string; version?: string; highlights?: unknown[]};
};

function WhatsNew() {
  const note = useGlobalData()['qaboard-latest-release-note']?.default as LatestNote | null | undefined;
  if (!note)
    return null;
  return (
    <div className={styles.whatsNew}>
      <h3 className={styles.whatsNewTitle}>
        What&apos;s new: <Link to={note.permalink}>{note.title}</Link>
      </h3>
      <ReleaseNoteHighlights frontMatter={note.frontMatter} />
      <Link to="/release-notes">All release notes →</Link>
    </div>
  );
}

function FinalCta() {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.finalCta}>
          <h2 className={styles.sectionTitle}>See it on your computer</h2>
          <p className={styles.sectionLead}>
            Start a server, run an example project and open its results in a few commands.
          </p>
          <div className={clsx(styles.ctas, styles.ctasCentered)}>
            <Link className="button button--primary button--lg" to="/docs/get-started/quickstart">
              Run it locally
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/tour">
              Take the tour
            </Link>
          </div>
        </div>
        <WhatsNew />
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      title="Results review for algorithm teams"
      description="Tests tell you it runs. QA-Board shows you it's better: every commit's outputs and metrics next to the reference's. Open source and self-hosted.">
      <Hero />
      <main>
        <ProofStrip />
        <InHouse />
        <Loop />
        <UseCases />
        <PolishGrid />
        <FitsYourStack />
        <Roadmap />
        <FinalCta />
      </main>
    </Layout>
  );
}
