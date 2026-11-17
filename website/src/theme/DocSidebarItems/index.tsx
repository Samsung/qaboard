// Wraps the docs sidebar's items to put the docs' sections (one per audience) at the top of the sidebar, on desktop
// and in the mobile menu. See src/components/DocsSwitcher. Categories render their items with level > 1.
import React, {type ReactNode} from 'react';
import DocSidebarItems from '@theme-original/DocSidebarItems';
import type DocSidebarItemsType from '@theme/DocSidebarItems';
import type {WrapperProps} from '@docusaurus/types';
import DocsSwitcher from '@site/src/components/DocsSwitcher';

type Props = WrapperProps<typeof DocSidebarItemsType>;

export default function DocSidebarItemsWrapper(props: Props): ReactNode {
  return (
    <>
      {props.level === 1 && <DocsSwitcher />}
      <DocSidebarItems {...props} />
    </>
  );
}
