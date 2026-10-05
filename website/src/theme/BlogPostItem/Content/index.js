/**
 * Swizzled (ejected) from @docusaurus/theme-classic to show the release notes' description and
 * highlights (frontmatter) above their content, also in the list view and the RSS/Atom feeds.
 * The only change from the original is <ReleaseNoteHighlights/>.
 */
import React from 'react';
import clsx from 'clsx';
import {blogPostContainerID} from '@docusaurus/utils-common';
import {useBlogPost} from '@docusaurus/plugin-content-blog/client';
import MDXContent from '@theme/MDXContent';
import ReleaseNoteHighlights from '@site/src/components/ReleaseNoteHighlights';

export default function BlogPostItemContent({children, className}) {
  const {isBlogPostPage, frontMatter, metadata} = useBlogPost();
  const isReleaseNote = metadata.permalink.includes('/release-notes/');
  return (
    <div
      // This ID is used for the feed generation to locate the main content
      id={isBlogPostPage ? blogPostContainerID : undefined}
      className={clsx('markdown', className)}>
      {isReleaseNote && <ReleaseNoteHighlights frontMatter={frontMatter} />}
      <MDXContent>{children}</MDXContent>
    </div>
  );
}
