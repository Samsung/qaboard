import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './index.module.css';
import HomepageFeatures from '../components/HomepageFeatures';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {Feature} from '../components/feature';


function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <h1 className="hero__title">{siteConfig.title}</h1>
        <p className="hero__subtitle" dangerouslySetInnerHTML={{__html: siteConfig.tagline}}></p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to={useBaseUrl('docs/introduction').replace('docs/docs/', 'docs/')}
          >
            Get Started
          </Link>
          <span className={styles.indexCtasGitHubButtonWrapper}>
              <iframe
                className={styles.indexCtasGitHubButton}
                src="https://ghbtns.com/github-btn.html?user=Samsung&amp;repo=qaboard&amp;type=star&amp;count=true&amp;size=large"
                width={160}
                height={30}
                title="GitHub Stars"
              />
            </span>
        </div>
      </div>
    </header>
  );
}


// The docs have one section per audience
function Audiences() {
  // In the build for the web app, the docs are at the root of the /docs/ baseUrl
  const docs = path => useBaseUrl(`docs/${path}`).replace('docs/docs/', 'docs/');
  const audiences = [
    {
      title: 'I look at results',
      text: 'Find your commits, compare them with a reference, dig into metrics, images and logs, run tests from the web app.',
      to: docs('user-guide/overview'),
      cta: 'User guide',
    },
    {
      title: 'I set up a project',
      text: 'Wrap your code with the qa CLI, define inputs, metrics and visualizations, run batches locally, on a cluster or in CI.',
      to: docs('introduction'),
      cta: 'Project setup',
    },
    {
      title: 'I run the server',
      text: 'Deploy QA-Board with docker compose or Kubernetes, upgrade without downtime, manage storage and users.',
      to: docs('backend-admin/deployment'),
      cta: 'Admin guide',
    },
  ];
  const releaseNotes = useBaseUrl('release-notes');
  return (
    <section className={clsx('container', styles.audiences)}>
      <div className={styles.audienceGrid}>
        {audiences.map(a => (
          <Link key={a.title} to={a.to} className={styles.audienceCard}>
            <h3>{a.title}</h3>
            <p>{a.text}</p>
            <span className={styles.audienceCta}>{a.cta} →</span>
          </Link>
        ))}
      </div>
      <p className={styles.whatsNew}>
        <Link to={releaseNotes}>✨ What's new in QA-Board? Read the release notes →</Link>
      </p>
    </section>
  );
}


export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`Hello from ${siteConfig.title}`}
      description={siteConfig.tagline.replace("<br/>", " ")}>
      <HomepageHeader />
      <main>
        <Audiences />
        <HomepageFeatures />

        <div className="container">
      <Feature
        img={<img src={useBaseUrl('img/slides/commit-list.jpg')} alt="Annotations" loading="lazy" />}
        title="Organize & Share"
        text={
          <>
            <p>
              Triggered runs from the <strong>CI or locally</strong>, and see them <strong>all in one place</strong>.
            </p>
            <p>
              QA-Board is aware of version control; you can filter by commit, branch, author, message...
            </p>
          </>
        }
      />
      <Feature
        img={<img src={useBaseUrl('img/slides/always-compare.jpg')} alt="Always Compare" loading="lazy" />}
        title="Always Compare"
        reversed
        text={
          <>
            <p>
              Whether you look at metrics or visualizations, QA-Board always compares each output to a reference version. You can <a href="https://samsung.github.io/qaboard/docs/references-and-milestones">save Milestones</a> to benchmark new results.
            </p>
            <p>
              You can compare configurations and filter results however you like.
            </p>
          </>
        }
      />
      <Feature
        img={<img src={useBaseUrl('img/slides/aggregate.jpg')} alt="Aggregation and rich KPIs" loading="lazy" />}
        title="Rich Metrics"
        text={
          <>
            <p>
              Real-world project need to look at heterogenuous KPIs: performance, quality, training time...
            </p>
            <p>
              QA-Board lets you <a href="https://samsung.github.io/qaboard/docs/computing-quantitative-metrics">define as many metrics as needed</a>, add metada (targets, label, units..), and can give you aggregated summaries as well as granular tables.
            </p>
          </>
        }
      />
      <Feature
        img={<img src={useBaseUrl('img/slides/show-files.jpg')} alt="File-based Visualizations" loading="lazy" />}
        title="Output Visualizations"
        reversed
        text={
          <>
            <p>
              With QA-Board, each run dumps files in an output folder. When comparing results, you see a diff of all the files. Files are displayed with a <a href="https://samsung.github.io/qaboard/docs/visualizations#available-file-viewers">wide range of viewers</a>: <strong>first-party support for <a href="https://plotly.com/python/">plotly</a></strong>, text, images, synced videos, 3d pointclouds, raw HTML...
            </p>
            <p>
              You can <a href="https://samsung.github.io/qaboard/docs/visualizations">declaratively create visualizations</a> to show e.g. multiple images, debug data, sliders....
            </p>
          </>
        }
      />
      <Feature
        img={<img src={useBaseUrl('img/slides/image-viewer.jpg')} alt="Advanced Image Viewer" loading="lazy" />}
        title="Advanced Image Viewer"
        text={
          <>
            <p>
              QA-Board notably supports a performance image viewer based on <a href="https://openseadragon.github.io/">OpenSeaDragon</a>. At Samsung it lets use work smoothly with >100MP images.
            </p>
            <p>
              Advanced features include showing perceptual differences, automatically finding interesting (or defining ahead of time) "Regions of Interest", use histograms, color tooltips and image filters.
            </p>
          </>
        }
      />
      <Feature
        img={<img src={useBaseUrl('img/slides/tuning.jpg')} alt="Tuning & Optimization" loading="lazy" />}
        title="Tuning & Optimization"
        reversed
        text={
          <>
            <p>
              <a href="https://samsung.github.io/qaboard/docs/batches-running-on-multiple-inputs">Define batches of inputs</a> to run on files/databases that matter to you. Start tuning experiments to compare parameters or feature flags  
            </p>
            <p>
              Use Grid-Search or <strong>Black-box optimization</strong> (via <a href="https://scikit-optimize.github.io/">scikit-optimize</a>), and analyse trade-offs. Use <a href="https://github.com/Samsung/qaboard/wiki/Adding-new-runners">common tools</a> for distributed runs.
            </p>
            <iframe style={{maxWidth: "450px"}} width="100%" height="315" src="https://www.youtube.com/embed/XN71PBr0Rvg" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
          </>
        }
      />
      <Feature
        img={<img src={useBaseUrl('img/slides/triggers.jpg')} alt="Integrations" loading="lazy" />}
        title="Integrations"
        text={
          <>
            <p>
              From QA-Board itsef you can link to your docs, or artifacts. You can also add buttons to <a href="https://samsung.github.io/qaboard/docs/triggering-third-party-tools">trigger 3rd party tools</a> like Jenkins, GitlabCi, or webhooks. <strong>When runing during CI runs</strong>, QA-Board will update your CI tool with the run's status.
            </p>
          </>
        }
      />
      <Feature
        img={<img src={useBaseUrl('img/slides/regressions.jpg')} alt="Regression Explorer" loading="lazy" />}
        title="Regression Explorer"
        reversed
        text={
          <>
            <p>
              If a regression occured, you can simply quickly investigate when it happened, and diff the change.
            </p>
            <p>
              More generally, QA-Board can be used for dashboard that show progress over time.
            </p>
          </>
        }
      />
      <Feature
        title="More features..."
        text={
          <>
            <p>
              Mono-repo support, Bit-accuracy checks, Input metadata....
            </p>
          </>
        }
      />
     </div>
      </main>
    </Layout>
  );
}
