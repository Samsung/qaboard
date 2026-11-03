// Copies a link to the page, as chats and documents paste it: its name, not a long URL (see copyLink)
import { Button, Classes, Tooltip } from "@blueprintjs/core";

import { copyLink } from "../utils/clipboard";


export const CopyLinkButton = ({ text, details, what = 'the link to this page', ...props }) => (
  <Tooltip content={<span>Copy a link to this page. In Teams, Outlook or Confluence it pastes as “{text}”.</span>} hoverOpenDelay={300}>
    <Button
      icon="link"
      variant="minimal"
      className={Classes.TEXT_MUTED}
      aria-label="Copy a link to this page"
      onClick={() => copyLink({ text, details }, { what })}
      {...props}
    />
  </Tooltip>
);

export default CopyLinkButton;
