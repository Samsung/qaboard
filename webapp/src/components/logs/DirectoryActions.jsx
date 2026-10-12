import React from "react";
import { AnchorButton, Button, Classes, Intent, Tooltip } from "@blueprintjs/core";

import { toaster } from "../../toaster";
import { folder_url, hasPathMappings } from "../../utils/paths";
import { linuxPath, pathFromUrl, windowsPath } from "../../files/logic";
import { copyText } from "./clipboard";


// "/s/algo/a%20b/" => "/algo/a b", or with path mappings "\\netapp\algo\a b"
export const directoryPath = (url, { windows = false } = {}) => {
  const path = pathFromUrl(url)
  return windows ? windowsPath(path) : linuxPath(path)
}


// Copies the path of a folder served under /s/. With path mappings, the Windows path is one click away.
export function copyDirectory(url, { windows = false } = {}) {
  const path = directoryPath(url, { windows })
  return copyText(path).then(copied => toaster.show(copied
    ? {
        message: <>Copied {windows ? 'the Windows path' : 'the path'}: <code className={Classes.MONOSPACE_TEXT} style={{ overflowWrap: 'anywhere' }}>{path}</code></>,
        icon: 'tick',
        intent: Intent.SUCCESS,
        timeout: 4000,
        action: !windows && hasPathMappings() ? { text: 'Copy the Windows path', onClick: () => copyDirectory(url, { windows: true }) } : undefined,
      }
    : { message: 'Could not copy the path', intent: Intent.DANGER },
  // repeated copies update the same toast
  'copy-directory'))
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
