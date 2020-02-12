import React from 'react';
import classnames from 'classnames';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';

const features = [
  {
    title: <>What is QA-Board?</>,
    imageUrl: 'img/undraw/undraw_forming_ideas_0pav.svg',
    description: (
      <>
        QA-Board helps Algorithms and QA engineers build great products. It offers powerful quality evaluation and collaboration tools.
      </>
    ),
  },
  {
    title: <>What does it do?</>,
    imageUrl: 'img/undraw/undraw_ideation_2a64.svg',
    description: (
      <>
        Compare results between commits. Create advanced visualizations from your existing output files. Track metrics across time. Start tuning experiments.
      </>
    ),
  },
  {
    title: <>How do I use it?</>,
    imageUrl: 'img/undraw/undraw_factory_dy0a.svg',
    description: (
      <>
        Run your code with a small CLI wrapper. You will see results from the web application.
      </>
    ),
  },
];

function Home() {
  const context = useDocusaurusContext();
  const { siteConfig = {} } = context;

  return (
    <Layout
      title={siteConfig.title}
      description={siteConfig.tagline}
    >
      <header className={classnames('hero hero--primary', styles.heroBanner)}>
        <div className="container">
          <h1 className="hero__title">{siteConfig.title}</h1>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <div className={styles.buttons}>
            <Link
              className={classnames(
                'button button--secondary button--lg',
                styles.getStarted,
              )}
              to={useBaseUrl('docs/introduction')}
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
      <main>
        {features && features.length && (
          <section className={styles.features}>
            <div className="container">
              <div className="row">
                {features.map(({ imageUrl, title, description }, idx) => (
                  <div
                    key={idx}
                    className={classnames('col col--4', styles.feature)}
                  >
                    {imageUrl && (
                      <div className="text--center">
                        <img
                          className={styles.featureImage}
                          src={useBaseUrl(imageUrl)}
                          alt={title}
                        />
                      </div>
                    )}
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      {/* <div className="container">
        <div className="row">
          <div className="col col--6 col--offset-3 padding-vert--lg">
            <h2>Introduction Video</h2>
            <iframe
              width="100%"
              height="315"
              src="https://www.youtube.com/embed/nYkdrAPrdcw"
              frameborder="0"
              allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
            />
            <div className="text--center padding-vert--lg">
              <Link
                className="button button--primary button--lg"
                to={useBaseUrl('docs/introduction')}
              >
                Learn more about QA-Board!
              </Link>
            </div>
          </div>
        </div>
      </div> */}
      </main>
    </Layout>
  );
}

export default Home;