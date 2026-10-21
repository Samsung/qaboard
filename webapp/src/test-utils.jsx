// Render components with the app's providers, with a fresh query cache for each test.
//   import { renderWithProviders } from '../../test-utils'
//   const { queryClient } = renderWithProviders(<MyComponent/>, { siteConfig: { docs_root: '/qa/' } })
//   milestones: { [project]: [milestone, ...] or {list, favorite_groups} }, else components that show milestones fetch them
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { siteConfigQuery, default_site_config, userQuery } from './api/queries';
import { milestonesQuery, index_milestones } from './milestones/api';
import { ComparisonContext } from './hooks';
import { side_color } from './sideColors';

export const makeQueryClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
});

// What the page calls the new and reference results, and their colors (useLabels)
export const test_labels = { new: 'new', reference: 'reference', colors: { new: side_color(0), reference: side_color(1) } };
const page_comparison = { labels: test_labels };

// siteConfig and user are put in the cache, so that tests don't need to mock those API calls.
// The page compares results named and colored like test_labels.
export function renderWithProviders(ui, { queryClient = makeQueryClient(), siteConfig, user, milestones, ...options } = {}) {
  for (const [project, value] of Object.entries(milestones ?? {}))
    queryClient.setQueryData(milestonesQuery(project).queryKey, Array.isArray(value) ? index_milestones(value) : index_milestones(value.list, value.favorite_groups));
  if (siteConfig) queryClient.setQueryData(siteConfigQuery.queryKey, { ...default_site_config, ...siteConfig });
  if (user) queryClient.setQueryData(userQuery.queryKey, user);
  const Wrapper = ({ children }) => <QueryClientProvider client={queryClient}>
    <ComparisonContext.Provider value={page_comparison}>{children}</ComparisonContext.Provider>
  </QueryClientProvider>;
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}
