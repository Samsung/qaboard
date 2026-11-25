// Inputs loaded by pages (useInfiniteQuery), read by index: what InputGrid and the viewer need.
import { useInfiniteQuery } from "@tanstack/react-query";


export const usePagedInputs = options => {
  const query = useInfiniteQuery(options);
  const pages = query.data?.pages ?? [];
  const items = pages.flatMap(page => page.inputs ?? []);
  const first = pages[0];
  const count = first ? Math.max(first.total ?? 0, items.length) : 0;
  const item_at = index => items[index];
  // the grid asks once rows near the end show: one page at a time
  const loadMore = () => {
    if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
  };
  return {
    items,
    count,
    item_at,
    loadMore,
    first,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    error: query.error,
    refetch: query.refetch,
  };
};
