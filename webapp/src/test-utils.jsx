// Render components with the app's providers, with a fresh query cache for each test.
//   import { renderWithProviders } from '../../test-utils'
//   const { queryClient } = renderWithProviders(<MyComponent/>, { siteConfig: { docs_root: '/qa/' } })
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { siteConfigQuery, default_site_config, userQuery } from './api/queries';

export const makeQueryClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
});

// siteConfig and user are put in the cache, so that tests don't need to mock those API calls
export function renderWithProviders(ui, { queryClient = makeQueryClient(), siteConfig, user, ...options } = {}) {
  if (siteConfig) queryClient.setQueryData(siteConfigQuery.queryKey, { ...default_site_config, ...siteConfig });
  if (user) queryClient.setQueryData(userQuery.queryKey, user);
  const Wrapper = ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}
