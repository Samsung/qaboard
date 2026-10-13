// Makes these components available in every MDX page without an import:
// - <Shot id="...">, <Clip id="...">, <Compare before="..." after="...">. See docs-media/README.md.
// - <StackPicker />, and the <Tabs>/<TabItem> it drives. See website/STYLE.md#tabs-and-the-stack-picker.
import MDXComponents from '@theme-original/MDXComponents';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import Shot from '@site/src/components/Shot';
import Clip from '@site/src/components/Clip';
import Compare from '@site/src/components/Compare';
import StackPicker from '@site/src/components/StackPicker';

export default {
  ...MDXComponents,
  Shot,
  Clip,
  Compare,
  StackPicker,
  Tabs,
  TabItem,
};
