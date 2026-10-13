import React from "react";
import { AnchorButton, Button, Classes, Tooltip } from "@blueprintjs/core";

import { folder_url, hasPathMappings } from "../../utils/paths";
import { linuxPath, pathFromUrl, windowsPath } from "../../files/logic";
import { copyWithToast } from "../../utils/clipboard";


// "/s/algo/a%20b/" => "/algo/a b", or with path mappings "\\netapp\algo\a b"
export const directoryPath = (url, { windows = false } = {}) => {
  const path = pathFromUrl(url)
  return windows ? windowsPath(path) : linuxPath(path)
}


// Copies the path of a folder served under /s/. With path mappings, the Windows path is one click away.
export function copyDirectory(url, { windows = false } = {}) {
  const path = directoryPath(url, { windows })
  const what = windows ? 'the Windows path' : 'the path'
  return copyWithToast(path, {
    what,
    message: <>Copied {what}: <code className={Classes.MONOSPACE_TEXT} style={{ overflowWrap: 'anywhere' }}>{path}</code></>,
    timeout: 4000,
    action: !windows && hasPathMappings() ? { text: 'Copy the Windows path', onClick: () => copyDirectory(url, { windows: true }) } : undefined,
  })
}


/**
 * Buttons to copy the path of a folder, and to open it in the file browser.
 * `what` names the folder in tooltips: "the output directory", "the batch directory"...
 */
export const DirectoryActions = ({ url, what = "the output directory" }) => <>
  <Tooltip content={`Copy the path of ${what}`} hoverOpenDelay={300}>
    <Button size="small" variant="minimal" icon="duplicate" aria-label={`Copy the path of ${what}`} onClick={() => copyDirectory(url)} />
  </Tooltip>
  <Tooltip content={`Open ${what}`} hoverOpenDelay={300}>
    <AnchorButton size="small" variant="minimal" icon="folder-shared-open" aria-label={`Open ${what}`} href={folder_url(url)} target="_blank" rel="noopener noreferrer" />
  </Tooltip>
</>
