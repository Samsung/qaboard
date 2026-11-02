// The landing page (docs/docs-overhaul-plan.md §6). Every claim here is shipped, or labeled: see website/STYLE.md.
// Media ids are literals, so the docs build checks them (plugins/media); unpublished ones show as placeholders.
// Budgets: the hero poster is the LCP element, media have their size before they load (no layout shift), clips only
// load and play when in view, and in the loop and the viewers' tabs, only the selected tab's media is in the page.
// Order: who it's for and what they see (hero), proof, the problem, the loop, the viewers, the details, use cases,
// then the stack, the roadmap and how to start.
import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useGlobalData from '@docusaurus/useGlobalData';
import Shot from '@site/src/components/Shot';
import Clip from '@site/src/components/Clip';
import StatusBadge from '@site/src/components/StatusBadge';
import ReleaseNoteHighlights from '@site/src/components/ReleaseNoteHighlights';
import Viewers from '@site/src/components/landing/Viewers';
import {useTabs} from '@site/src/components/landing/useTabs';
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

// Who it's for: each links to its use case
const AUDIENCES = [
  {label: 'Camera and ISP', to: '/docs/use-cases/image-quality'},
  {label: 'Computer vision and ML', to: '/docs/use-cases/detection-eval'},
  {label: 'Robotics', to: '/docs/use-cases/robotics-3d'},
  {label: 'Embedded', to: '/docs/bit-accuracy'},
  {label: 'Performance', to: '/docs/use-cases/serving-latency'},
];

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
            Every commit runs on your test set. QA-Board puts its outputs next to the reference&apos;s (images, videos,
            point clouds, plots, flame graphs, logs and metrics) so your team sees what changed, agrees it&apos;s
            better, and ships it.
          </p>
          <div className={styles.audience}>
            <span className={styles.audienceLabel} id="hero-audience">
              For
            </span>
            <ul aria-labelledby="hero-audience">
              {AUDIENCES.map(({label, to}) => (
                <li key={label}>
                  <Link to={to}>{label}</Link>
                </li>
              ))}
            </ul>
          </div>
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
    text: 'Images and videos side by side, wiped or diffed, zoomed in sync down to the pixel. Point clouds and trajectories, plots overlaid, flame graphs diffed, reports, logs and text.',
    link: '#viewers',
    linkLabel: 'Every viewer, below',
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
    text: 'Start parameter sweeps from the web app, or an automated tuning, then see each parameter’s effect and the trade-offs in the Tuning Analysis view.',
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

// In-page links (#viewers) are plain anchors: the docs' link checker only knows the docs' headings
function StepLink({to, children}: {to: string; children: ReactNode}) {
  return to.startsWith('#') ? <a href={to}>{children}</a> : <Link to={to}>{children}</Link>;
}

function Loop() {
  const {selected, tabListProps, tabProps, panelProps} = useTabs(STEPS.length, 'The review loop');
  const step = STEPS[selected];
  return (
    <section className={clsx(styles.section, styles.sectionAlt)}>
      <div className="container">
        <SectionHeader eyebrow="The loop" title="Run, compare, look, find, tune, gate">
          The same review loop for every algorithm: camera pipelines, models, servers, embedded code.
        </SectionHeader>
        <div className={styles.loop}>
          <div className={styles.loopTabs} {...tabListProps}>
            {STEPS.map((s, index) => (
              <button key={s.name} {...tabProps(index)} className={clsx(styles.loopTab, index === selected && styles.loopTabSelected)}>
                <span className={styles.loopNumber} aria-hidden="true">
                  {index + 1}
                </span>
                <span className={styles.loopName}>{s.name}</span>
                {s.experimental && <span className={styles.loopExperimental}>Experimental</span>}
              </button>
            ))}
          </div>
          <div className={styles.loopPanel} {...panelProps}>
            <div className={styles.loopText}>
              <h3 className={styles.loopTitle}>
                {step.title} {step.experimental && <StatusBadge status="experimental" />}
              </h3>
              <p>{step.text}</p>
              <StepLink to={step.link}>{step.linkLabel} →</StepLink>
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
    text: 'A denoiser wins PSNR but adds halos: synced zoom, image differences, a 113 MP test wall, every stage of the pipeline.',
    to: '/docs/use-cases/image-quality',
  },
  {
    audience: 'Computer vision, ML',
    title: 'Model evaluation',
    text: 'An int8 detector is 72% smaller and misses small objects: metrics per class and object size, PR curves over the reference.',
    to: '/docs/use-cases/detection-eval',
  },
  {
    audience: 'Robotics, perception',
    title: 'Odometry and mapping',
    text: 'A false loop closure pulls the trajectory meters away: 6DoF trajectories against the ground truth, point clouds, depth video in sync.',
    to: '/docs/use-cases/robotics-3d',
  },
  {
    audience: 'Embedded, HW/SW co-design',
    title: 'Bit accuracy',
    text: 'Check in CI that a change left every output file identical, before you hand a fixed-point model over to a hardware team.',
    to: '/docs/bit-accuracy',
  },
  {
    audience: 'Performance engineering',
    title: 'Serving latency',
    text: 'A shared cache saves CPU and takes p99 from milliseconds to seconds: latency tails, flame graph diffs, History, a tuning frontier.',
    to: '/docs/use-cases/serving-latency',
  },
  {
    audience: 'LLM agents',
    title: 'Agent evals',
    text: 'Shorter tool descriptions, and an assistant reboots robots without asking: transcripts diffed, a report per task, pass rate and cost.',
    to: '/docs/use-cases/agent-evals',
  },
];

function UseCases() {
  return (
    <section className={clsx(styles.section, styles.sectionAlt)}>
      <div className="container">
        <SectionHeader eyebrow="Use cases" title="For outputs that pass/fail tests can't judge">
          Each use case follows a demo project: the problem, the workflow, and the configuration that produces what you
          see.
        </SectionHeader>
        <ul className={clsx(styles.cards, styles.cardsThree)}>
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

// Tiles about 370 px wide: the landing/* shots are 16:10 crops made for them (docs-media/shots/landing.spec.ts). Other
// shots fit in the same 16:10 box; `top` shows the top of a tall one, `left` fills the box with the left of a wide one.
// Nothing here repeats the viewers above: the most differentiating first.
type Detail = {title: string; text: ReactNode; media: ReactNode; fit?: 'top' | 'left'};

const DETAILS: Detail[] = [
  {
    title: 'Which runs changed most',
    text: 'The server compares the images of every run on the page with the reference’s, and ranks the runs by their largest difference: start your review where it matters.',
    media: <Shot id="commit/regions-all-runs" caption="" />,
    fit: 'top',
  },
  {
    title: 'Every stage, synced',
    text: 'One slider over a camera pipeline’s stages, from the raw mosaic to the output, drives every run’s card at once.',
    media: <Clip id="landing/every-stage" caption="" />,
  },
  {
    title: 'Bit accuracy before a hardware handoff',
    text: 'Only the output files that changed, each diffed with the reference’s. A commit that changes none is bit-accurate.',
    media: <Clip id="landing/bit-accuracy" caption="" />,
  },
  {
    title: 'Why a run failed',
    text: 'When LSF kills a run, its log says why, compares the memory it used with what it asked for, and says what to change.',
    media: <Shot id="logs/lsf-hints" caption="" />,
    fit: 'left',
  },
  {
    title: 'Tuning frontiers',
    text: 'Every configuration of a sweep, one metric against another: see which ones sit on the efficient frontier.',
    media: <Shot id="tuning/frontier" caption="" />,
    fit: 'left',
  },
  {
    title: 'The file’s own values',
    text: 'Hover a pixel: its values in both images as your code saved them, 16-bit or float included, not only the colors on screen.',
    media: <Shot id="landing/pixel-values" caption="" />,
  },
  {
    title: 'Milestones',
    text: 'Save a release as a shared milestone, an experiment as a private one, and compare any commit with them.',
    media: <Shot id="commits/milestones-menu" caption="" />,
    fit: 'left',
  },
  {
    title: 'Live logs',
    text: 'Follow a running log, count its errors, and jump from one to the next.',
    media: <Clip id="logs/live-tail" caption="" />,
  },
  {
    title: 'File browser',
    text: (
      <>
        Every run’s folder in the browser, from the keyboard: <kbd>j</kbd> <kbd>k</kbd> to move, <kbd>/</kbd> to filter,{' '}
        <kbd>c</kbd> to copy a path.
      </>
    ),
    media: <Clip id="files/keyboard" caption="" />,
    fit: 'left',
  },
];

function Details() {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader eyebrow="The details" title="Polish you'd never build in-house">
          Years of daily use on dozens of projects, in the web app you get on day one.
        </SectionHeader>
        <ul className={styles.polishGrid}>
          {DETAILS.map(({title, text, media, fit}) => (
            <li key={title} className={styles.polishItem}>
              <div className={clsx(styles.polishMedia, fit === 'top' && styles.fitTop, fit === 'left' && styles.fitLeft)}>{media}</div>
              <h3 className={styles.polishTitle}>{title}</h3>
              <p className={styles.polishText}>{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ViewersSection() {
  return (
    <section id="viewers" className={clsx(styles.section, styles.stage)}>
      <div className="container">
        <SectionHeader eyebrow="Viewers" title="Built for heavy data">
          Each kind of output gets a viewer that puts the new run next to the reference, in sync, and shows where they
          differ: images and videos down to the pixel, 3D maps, flame graphs, plots and reports.
        </SectionHeader>
        <Viewers />
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
            <Link className="button button--secondary button--lg" to="/docs/user-guide/first-review">
              Take a first look
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
      description="Tests tell you it runs. QA-Board shows you it's better: every commit's outputs (images, videos, plots, flame graphs) and metrics next to the reference's. Open source and self-hosted.">
      <Hero />
      <main>
        <ProofStrip />
        <InHouse />
        <Loop />
        <ViewersSection />
        <Details />
        <UseCases />
        <FitsYourStack />
        <Roadmap />
        <FinalCta />
      </main>
    </Layout>
  );
}
