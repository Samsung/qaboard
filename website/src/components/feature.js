// https://github.com/kamilkisiela/graphql-inspector/blob/2784988e06e38a36ebd82da02cb34a771387acfe/website/src/components/feature.js
import React from 'react';

import clsx from 'clsx';
import styles from './feature.module.css';

export function Feature({reversed, title, img, text}) {
  const left = <div className={styles.featureImage}>{img}</div>;
  const right = (
    <div className={styles.featureText}>
      <h3 className={styles.featureTitle}>{title}</h3>
      {text}
    </div>
  );

  return (
    <div className={styles.featureContainer}>
      <div
        className={clsx('col col--12', styles.featureContent, {[styles.reversed]: reversed === true})}
      >
        {reversed ? (
          <>
            {right}
            {left}
          </>
        ) : (
          <>
            {left}
            {right}
          </>
        )}
      </div>
    </div>
  );
}