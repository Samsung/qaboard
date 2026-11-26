// Inputs loaded by pages (useInfiniteQuery), read by index: what InputGrid and the viewer need.
import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";


export const usePagedInputs = options => {
  const query = useInfiniteQuery(options);
  const pages = query.data?.pages ?? [];
  const items = pages.flatMap(page => page.inputs ?? []);
  const first = pages[0];
  const count = first ? Math.max(first.total ?? 0, items.length) : 0;
  const item_at = index => items[index];
  // `loadMore(index)`: the grid and the viewer need the inputs up to `index` (without it: the next page). Pages load
  // one after the other until they're there, also when users scroll faster than pages arrive.
  const [wanted, setWanted] = useState(-1);
  const loadMore = index => setWanted(w => Math.max(w, index ?? items.length));
  const { hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = query;
  useEffect(() => {
    if (wanted >= items.length && hasNextPage && !isFetchingNextPage && !isFetching) fetchNextPage();
  }, [wanted, items.length, hasNextPage, isFetchingNextPage, isFetching, fetchNextPage]);
  // other filters, another list: from its start
  const key = JSON.stringify(options.queryKey);
  const [seen_key, setSeenKey] = useState(key);
  if (seen_key !== key) {
    setSeenKey(key);
    setWanted(-1);
  }
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
