// Docusaurus's JSON-LD of a release note or blog post, with the URLs that the site serves
// (src/components/structuredData.ts)
import React, {type ReactNode} from 'react';
import Head from '@docusaurus/Head';
import {useBlogPostStructuredData} from '@docusaurus/plugin-content-blog/client';
import {useWithTrailingSlash} from '@site/src/components/structuredData';

export default function BlogPostStructuredData(): ReactNode {
  const withTrailingSlash = useWithTrailingSlash();
  const structuredData = withTrailingSlash(useBlogPostStructuredData());
  return (
    <Head>
      <script type="application/ld+json">{JSON.stringify(structuredData)}</script>
    </Head>
  );
}
