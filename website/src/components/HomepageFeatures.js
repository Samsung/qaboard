import React from 'react';
import clsx from 'clsx';
import styles from './HomepageFeatures.module.css';

const FeatureList = [
  {
    title: <>What is QA-Board?</>,
    Svg: require('../../static/img/undraw/undraw_forming_ideas_0pav.svg').default,
    description: (
      <>
        QA-Board helps Algorithms and QA engineers build great products. It offers powerful quality evaluation and collaboration tools.
      </>
    ),
  },
  {
    title: <>What does it do?</>,
    Svg: require('../../static/img/undraw/undraw_ideation_2a64.svg').default,
    description: (
      <>
        Compare results between commits. Create advanced visualizations from your existing output files. Track metrics across time. Start tuning experiments.
      </>
    ),
  },
  {
    title: <>How do I use it?</>,
    Svg: require('../../static/img/undraw/undraw_factory_dy0a.svg').default,
    description: (
      <>
        Run your code with a small CLI wrapper. You will see results from the web application.
      </>
    ),
  },
];


function Feature({Svg, title, description}) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} alt={title} />
      </div>
      <div className="text--center padding-horiz--md">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
