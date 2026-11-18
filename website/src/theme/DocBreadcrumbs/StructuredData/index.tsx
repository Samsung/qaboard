// Docusaurus's breadcrumbs JSON-LD, with the URLs that the site serves (src/components/structuredData.ts)
import React, {type ReactNode} from 'react';
import Head from '@docusaurus/Head';
import {useBreadcrumbsStructuredData} from '@docusaurus/plugin-content-docs/client';
import type {Props} from '@theme/DocBreadcrumbs/StructuredData';
import {useWithTrailingSlash} from '@site/src/components/structuredData';

export default function DocBreadcrumbsStructuredData(props: Props): ReactNode {
  const withTrailingSlash = useWithTrailingSlash();
  const structuredData = withTrailingSlash(useBreadcrumbsStructuredData({breadcrumbs: props.breadcrumbs}));
  return (
    <Head>
      <script type="application/ld+json">{JSON.stringify(structuredData)}</script>
    </Head>
  );
}
