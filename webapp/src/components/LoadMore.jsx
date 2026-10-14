// For long lists we render or fetch progressively: more comes when users scroll to the end, or click.
//   {hasMore && <LoadMore onLoadMore={fetchNextPage} loading={isFetchingNextPage} text="More commits"/>}
import { useEffect, useRef } from "react";
import { Button } from "@blueprintjs/core";


// `loaded`: how many items are shown, we check again if the end is still visible when it changes
export const LoadMore = ({ onLoadMore, loading = false, loaded, text = "Show more", margin = "400px" }) => {
  const ref = useRef(null);
  // the latest callback, without observing again at each render
  const callback = useRef(onLoadMore);
  useEffect(() => { callback.current = onLoadMore; });

  useEffect(() => {
    if (loading || !ref.current || typeof IntersectionObserver === 'undefined') return;
    // starts loading a bit before users reach the end
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) callback.current();
    }, { rootMargin: `0px 0px ${margin} 0px` });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [loading, loaded, margin]);

  return (
    <div ref={ref} style={{ display: 'flex', justifyContent: 'center', margin: '15px' }}>
      <Button minimal icon="chevron-down" loading={loading} text={text} onClick={() => onLoadMore()}/>
    </div>
  );
};
