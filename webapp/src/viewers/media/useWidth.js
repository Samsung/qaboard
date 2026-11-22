import { useEffect, useState } from 'react';

// An element's width as it changes: [ref callback, width]. `fallback` until it is measured (and in jsdom, without
// layout). A callback ref: the element can come later, e.g. after a loading state.
export const useWidth = (fallback = 800) => {
  const [element, setElement] = useState(null);
  const [width, setWidth] = useState(null);
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width || fallback, element];
};
