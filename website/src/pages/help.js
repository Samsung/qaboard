import React from 'react';
import classnames from 'classnames';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';

function Support() {
  const context = useDocusaurusContext();
  const { siteConfig = {} } = context;
  return (
    <Layout
      title={`Hello from ${siteConfig.title}`}
      description="Description will go into a meta tag in <head />"
    >
      <div className="container">
        <div className="row">
          <div className="col col--6 col--offset-3 padding-vert--lg">
            <h1>Need Help?</h1>
            <p>QA-Board is worked on full-time by Samsung's algorithm infrastructure teams. They're often around and available for questions. Contact <a href="mailto:arthur.flam@samsung.com">Arthur Flam</a></p>

            {/* {<h2>Stack Overflow</h2>
            <p>Many members of the community use Stack Overflow to ask questions. Read through the <a href="http://stackoverflow.com/questions/tagged/qaboard">existing questions</a> tagged with reactjs or <a href="http://stackoverflow.com/questions/ask">ask your own</a>!</p>} */}

            <h2>Twitter</h2>
            <p><a href="https://twitter.com/search?q=%23fluxjs">#qaboard hash tag on Twitter</a> is used to keep up with the latest QA-Board news.</p>
          </div>
        </div>
      </div>
    </Layout>
  );
}

export default Support;