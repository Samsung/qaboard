// Wide tables scroll sideways in their own box, while the page scrolls them vertically: their header stays under the
// page's fixed headers, their first column (the runs) stays on the left, and their horizontal scrollbar stays at the
// bottom of the window, not 5,000 rows below.
//
// Why not `position: sticky` for the header: the box that scrolls sideways is a scroll container, and sticky elements
// inside one stick to it, not to the window (and the commit page's sections have `overflow: hidden`). So we move the
// header's cells with a transform as the window scrolls. The first column is sticky within the box, in CSS.
import { useLayoutEffect, useRef, useState } from "react";
import styled from "styled-components";


const Frame = styled.div`
  position: relative;
  /* "there are more columns": a fade on the right edge */
  &::after {
    content: "";
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 24px;
    pointer-events: none;
    background: linear-gradient(to right, transparent, var(--qa-table-surface));
    opacity: 0;
    transition: opacity 150ms;
  }
  &[data-more-right]::after {
    opacity: 1;
  }
`;

const Scroll = styled.div`
  overflow-x: auto;
  overflow-y: hidden;
  /* the rail below is its scrollbar */
  &[data-rail] {
    scrollbar-width: none;
  }
  &[data-rail]::-webkit-scrollbar {
    display: none;
  }
  &:focus-visible {
    outline: 2px solid var(--qa-intent-primary);
    outline-offset: 2px;
  }
`;

const Rail = styled.div`
  position: relative;
  z-index: 4;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--qa-text-muted) transparent;
  background: var(--qa-table-surface);
  & > div {
    height: 1px;
  }
`;

// stickyTop: in pixels, the height of the page's fixed headers, under which the header's rows marked `.stick` stay.
// Without it, the header scrolls with the page.
// label: what screen readers call the box, that keyboards can scroll when the table is wider than it
export const TableScroller = ({ stickyTop, label, children }) => {
  const frame = useRef(null);
  const scroll = useRef(null);
  const rail = useRef(null);
  // the table's width, when it's wider than the box
  const [overflow, setOverflow] = useState(null);

  useLayoutEffect(() => {
    const box = scroll.current;
    const table = box.querySelector('table');
    if (!table) return;
    const update_size = () => {
      const width = box.scrollWidth > box.clientWidth + 1 ? box.scrollWidth : null;
      setOverflow(width);
    };
    update_size();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update_size);
    observer.observe(box);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

  // The header's rows and the rail follow the window's scroll. Direct style writes: no render while scrolling.
  useLayoutEffect(() => {
    const box = scroll.current;
    const thead = box.querySelector('thead');
    const stuck_rows = thead ? [...thead.querySelectorAll('tr.stick')] : [];
    let stuck = false;
    const update = () => {
      const rect = box.getBoundingClientRect();
      if (stickyTop !== undefined && stickyTop !== null && thead && stuck_rows.length > 0) {
        const head = thead.getBoundingClientRect();
        const stuck_height = stuck_rows.reduce((total, row) => total + row.offsetHeight, 0);
        // until the last rows: the header doesn't leave the table
        const max = Math.max(0, rect.height - stuck_height - 2 * stuck_rows[0].offsetHeight);
        const offset = Math.round(Math.max(0, Math.min(stickyTop - head.top, max)));
        thead.style.setProperty('--qa-stick', `${offset}px`);
        if ((offset > 0) !== stuck) {
          stuck = offset > 0;
          thead.toggleAttribute('data-stuck', stuck);
        }
      }
      if (rail.current) {
        // above the bottom of the window, but below the header
        const below = rect.bottom + rail.current.offsetHeight - window.innerHeight;
        const lift = Math.max(0, Math.min(below, rect.height - (thead?.offsetHeight ?? 0)));
        rail.current.style.transform = lift > 0 ? `translateY(${-lift}px)` : '';
      }
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(box);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
      thead?.style.removeProperty('--qa-stick');
      thead?.removeAttribute('data-stuck');
    };
  }, [stickyTop, overflow]);

  // the shadow of the first column, the fade on the right, and the rail follow the box's scroll
  const on_scroll = () => {
    const box = scroll.current;
    if (rail.current && rail.current.scrollLeft !== box.scrollLeft) rail.current.scrollLeft = box.scrollLeft;
    box.toggleAttribute('data-scrolled', box.scrollLeft > 0);
    frame.current.toggleAttribute('data-more-right', box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
  };
  useLayoutEffect(() => {
    if (!scroll.current) return;
    frame.current.toggleAttribute('data-more-right', overflow !== null && scroll.current.scrollLeft + scroll.current.clientWidth < overflow - 1);
  }, [overflow]);

  return <div>
    <Frame ref={frame}>
      <Scroll
        ref={scroll}
        onScroll={on_scroll}
        data-rail={overflow !== null ? '' : undefined}
        // keyboards scroll it with the arrow keys
        tabIndex={overflow !== null ? 0 : undefined}
        role={overflow !== null ? 'region' : undefined}
        aria-label={overflow !== null ? label : undefined}
      >
        {children}
      </Scroll>
    </Frame>
    {overflow !== null && <Rail
      ref={rail}
      aria-hidden
      onScroll={() => {
        if (scroll.current.scrollLeft !== rail.current.scrollLeft) scroll.current.scrollLeft = rail.current.scrollLeft;
      }}
    >
      <div style={{ width: overflow }}/>
    </Rail>}
  </div>;
};
