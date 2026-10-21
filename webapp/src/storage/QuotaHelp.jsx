// Why QA-Board's numbers differ from IT's quota, and how users find what takes space on disk themselves.
import { useState } from "react";
import { Button, Callout, Classes, Drawer, DrawerSize, InputGroup, Intent } from "@blueprintjs/core";

import { toaster } from "../toaster";


const copyToClipboard = text => navigator.clipboard?.writeText(text)
  .then(() => toaster.show({ message: 'Copied', icon: 'duplicate', timeout: 1500 }))
  .catch(() => toaster.show({ message: 'Could not copy: select the text and copy it', intent: Intent.WARNING }));


const Command = ({ title, command, children }) => <div style={{ marginBottom: 18 }}>
  <h6 className={Classes.HEADING} style={{ marginBottom: 4 }}>{title}</h6>
  {children && <p className={Classes.TEXT_MUTED} style={{ margin: '0 0 6px' }}>{children}</p>}
  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
    <pre className={Classes.CODE_BLOCK} style={{ margin: 0, flex: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{command}</pre>
    <Button icon="duplicate" variant="minimal" aria-label={`Copy: ${title}`} onClick={() => copyToClipboard(command)}/>
  </div>
</div>;

// `folder`: a folder to start from, e.g. the one from the quota alert
export const QuotaHelp = ({ isOpen, onClose, user_name, folder }) => {
  const [path, setPath] = useState(folder || '');
  const target = path.trim() || '/path/from/the/quota/alert';
  const user = user_name || '$USER';
  return <Drawer isOpen={isOpen} onClose={onClose} title="Why does IT's quota say something else?" icon="help" size={DrawerSize.STANDARD}>
    <div className={Classes.DRAWER_BODY}>
      <div style={{ padding: 20 }}>
        <p>
          QA-Board counts the files of the runs it knows: what <code>qa</code> measured when each run ended. IT's quota
          counts every file you own on the storage. They differ because of:
        </p>
        <ul>
          <li><strong>Files QA-Board doesn't track</strong>: exports ("Export to a shared folder" writes to a <code>share/</code> folder
            next to the commit's batches), files you copied or created yourself next to your runs, and files written after a run ended.</li>
          <li><strong>Deletions QA-Board doesn't know about yet</strong>: if you deleted folders yourself, QA-Board still counts their runs
            until they're cleaned up.</li>
          <li><strong>How the storage counts</strong>: many small files take more space than their size (blocks), and snapshots
            keep deleted files for a while.</li>
          <li><strong>Other folders</strong>: the quota covers everything you own on that storage, not only QA-Board's runs.</li>
        </ul>
        <Callout intent={Intent.PRIMARY} icon="lightbulb" style={{ marginBottom: 20 }}>
          Compare: in the <strong>Folders</strong> tab, open the folder from the quota alert to see what QA-Board knows there.
          Then measure it on disk with the commands below, from a terminal on a machine that sees the storage.
        </Callout>

        <label className={Classes.LABEL} htmlFor="quota-help-folder">
          The folder from the quota alert
          <InputGroup id="quota-help-folder" value={path} onChange={e => setPath(e.target.value)} placeholder="/algo/project/outputs/alice" className={Classes.MONOSPACE_TEXT} spellCheck={false}/>
        </label>

        <Command title="How much space the folder takes" command={`du -sh ${target}`}/>
        <Command title="Its biggest subfolders" command={`du -h --max-depth=3 ${target} 2>/dev/null | sort -rh | head -30`}>
          Slow on big folders: start with a small depth.
        </Command>
        <Command title="Your biggest files" command={`find ${target} -user ${user} -type f -size +100M -printf '%s\\t%p\\n' 2>/dev/null | sort -rn | head -50 | numfmt --to=si --field=1`}>
          Files over 100 MB that you own, the biggest first.
        </Command>
        <Command title="Your exports" command={`find ${target} -type d -name share -prune -exec du -sh {} + 2>/dev/null | sort -rh | head -30`}>
          Delete the exports you don't need anymore with <code>rm -r</code>: QA-Board doesn't track them.
        </Command>
        <p className={Classes.TEXT_MUTED}>
          Before deleting a run's folder yourself, prefer deleting the run from QA-Board: it knows the space is free, and
          the run stays listed as deleted.
        </p>
      </div>
    </div>
  </Drawer>;
};

export default QuotaHelp;
