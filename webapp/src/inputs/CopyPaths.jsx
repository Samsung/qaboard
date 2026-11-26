// Copying inputs' full paths: as Linux paths, or as Windows ones when the server has path mappings
// (/api/v1/config path_mappings, e.g. /algo => \\netapp\algo). Without them a Windows path would only flip slashes.
import { AnchorButton, Button, ButtonGroup, Tooltip } from "@blueprintjs/core";

import { copyWithToast } from "../utils/clipboard";
import { hasPathMappings, path_to_windows } from "../utils/paths";


// Copies paths, one per line, as Linux or Windows paths (with the server's path mappings: /algo => \\netapp\algo)
export const copyPaths = (paths, { windows = false, what } = {}) => copyWithToast(
  paths.map(path => windows ? path_to_windows(path) : path).join('\n'),
  { what: `${what ?? (paths.length === 1 ? 'the path' : `${paths.length.toLocaleString()} paths`)}${windows ? ' (Windows)' : ''}` },
);

// "Copy path", and its Windows path when the server knows how Linux paths map to Windows ones
export const CopyPathButtons = ({ paths, text = 'Copy path', what, ...props }) => {
  const windows = hasPathMappings();
  return <ButtonGroup>
    <Button icon="duplicate" text={text} title={paths.length === 1 ? paths[0] : undefined} onClick={() => copyPaths(paths, { what })} {...props}/>
    {windows
      ? <Button text="Windows" title={paths.length === 1 ? path_to_windows(paths[0]) : 'As Windows paths'} onClick={() => copyPaths(paths, { what, windows: true })} {...props}/>
      : <Tooltip content="Admins set how Linux paths map to Windows shares (path_mappings in the server's config): then this copies Windows paths." placement="top">
          <AnchorButton text="Windows" disabled {...props} onClick={undefined}/>
        </Tooltip>}
  </ButtonGroup>;
};
