// An anchor without a heading, for links to a section that moved or was merged: <Anchor id="old-heading-id" />.
// Unlike <a id>, the build's broken-anchor check knows it (like headings), and it scrolls below the navbar.
import React from 'react';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import {useAnchorTargetClassName} from '@docusaurus/theme-common';

export default function Anchor({id}: {id: string}) {
  useBrokenLinks().collectAnchor(id);
  return <span id={id} className={useAnchorTargetClassName(id)} />;
}
