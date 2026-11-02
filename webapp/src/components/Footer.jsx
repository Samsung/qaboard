// At the bottom of every page, even short ones: pages are flex columns at least as tall as the window
import { Classes } from "@blueprintjs/core";
import styled from "styled-components";

import { WhatsNewLink } from "../releaseNotes/ReleaseNotes";
import { useHelpSheet } from "./HelpSheet";

export const repository_url = "https://github.com/Samsung/qaboard";

const Bar = styled.footer`
  margin-top: auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 16px;
  padding: 10px 20px;
  border-top: 1px solid var(--qa-border);
  font-size: 12px;

  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
`;

const Footer = () => {
  const { open: openHelp } = useHelpSheet();
  return <Bar className={Classes.TEXT_MUTED}>
    <span>
      Made with ❤️ at Samsung · <a href={`${repository_url}/blob/master/LICENSE`} rel="noopener noreferrer" target="_blank">Apache License 2.0</a>
    </span>
    <nav aria-label="About QA-Board">
      <WhatsNewLink via="footer"/>
      <a href="#cheat-sheet" onClick={e => { e.preventDefault(); openHelp(); }} aria-keyshortcuts="?">Cheat sheet</a>
      <a href={repository_url} rel="noopener noreferrer" target="_blank">QA-Board on GitHub</a>
    </nav>
  </Bar>;
};

export default Footer;
