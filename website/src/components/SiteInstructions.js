import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Admonition from '@theme/Admonition';

// Points to the instructions of the site whose web app bundles these docs: website/site-docs/<site>/,
// built in only when QABOARD_SITE is set (see docusaurus.config.ts). Renders nothing in other builds.
export default function SiteInstructions({page = 'installation', children}) {
  const {siteConfig} = useDocusaurusContext();
  const site = siteConfig.customFields.site;
  if (!site)
    return null;
  return (
    <Admonition type="info" title="Your organization's instructions">
      <p>
        {children ?? `This QA-Board is set up for ${site.name}, which has its own instructions.`}{' '}
        <Link to={`/site/${page}`}>Read them →</Link>
      </p>
    </Admonition>
  );
}
