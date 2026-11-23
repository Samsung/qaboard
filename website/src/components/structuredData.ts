// Docusaurus builds the URLs of its structured data (docs' breadcrumbs, release notes and blog posts) without the
// site's trailing slash, unlike its canonical URLs and the sitemap: on GitHub Pages, they redirect. This adds the slash to
// the site's page URLs in that data. See trailingSlash in docusaurus.config.ts.
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

export function useWithTrailingSlash(): <T>(data: T) => T {
  const {siteConfig} = useDocusaurusContext();
  const site = `${siteConfig.url}${siteConfig.baseUrl}`;
  const fix = (value: unknown): unknown => {
    if (typeof value === 'string') {
      // Pages only: not files (an image, a feed) or URLs with a query or an anchor
      if (value.startsWith(site) && !value.endsWith('/') && !/[?#]/.test(value) && !/\.[a-z0-9]+$/i.test(value))
        return `${value}/`;
      return value;
    }
    if (Array.isArray(value))
      return value.map(fix);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fix(item)]));
    return value;
  };
  return <T,>(data: T) => (siteConfig.trailingSlash ? (fix(data) as T) : data);
}
