// Makes the media components available in every MDX page without an import:
// <Shot id="...">, <Clip id="...">, <Compare before="..." after="...">. See docs-media/README.md.
import MDXComponents from '@theme-original/MDXComponents';
import Shot from '@site/src/components/Shot';
import Clip from '@site/src/components/Clip';
import Compare from '@site/src/components/Compare';

export default {
  ...MDXComponents,
  Shot,
  Clip,
  Compare,
};
