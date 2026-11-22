// What opens in the section (the image viewer, the evolution strip) scrolls into view, below its sticky timeline:
// LoggedMedia sets --qa-media-sticky to the timeline's height.
import { useEffect, useRef } from "react";

export const STICKY_MARGIN = 'calc(var(--qa-sticky-top, 0px) + var(--qa-media-sticky, 130px) + 8px)';

// a ref for the element to bring into view when `shown` becomes truthy (or changes)
export const useScrollIntoView = shown => {
  const ref = useRef(null);
  useEffect(() => {
    if (shown) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [shown]);
  return ref;
};
