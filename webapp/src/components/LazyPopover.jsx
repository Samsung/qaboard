// Tooltips and menus for long lists: they're only created when users get to their target.
// Blueprint's popovers have over 150 hooks each and render twice when they mount: with a few per row,
// lists of 1000 commits spent most of their time and memory on popovers nobody opened.
// Until then, the target is in a wrapper laid out like theirs, and can be focused the same way.
import { cloneElement, useLayoutEffect, useRef, useState } from "react";
import { Classes, PopoverNext, Tooltip } from "@blueprintjs/core";


// How users got to the target: "hover", "focus" or "click". The popover then renders the target anew,
// which gets the focus back if users were on it.
const useReached = () => {
  const [reached, setReached] = useState(null);
  const target = useRef(null);
  useLayoutEffect(() => {
    if (reached === 'focus' || reached === 'click') target.current?.focus();
  }, [reached]);
  return [reached, setReached, target];
};

const wrapper_class = className => [className, Classes.POPOVER_TARGET].filter(Boolean).join(' ');
// Clicks focus links and buttons too: they must end on the element they started on
const keyboard_focus = event => event.target.matches(':focus-visible');


// For tooltips that also open on focus, around a target without a ref of its own (we set it)
export const LazyTooltip = ({ children, className, hoverOpenDelay = 100, ...props }) => {
  const [reached, setReached, target] = useReached();
  const timer = useRef(null);
  // Under the pointer, the new target gets no mouseenter (React only saw the old one): it starts open,
  // and closes when the pointer leaves, like any tooltip
  if (reached)
    return <Tooltip className={className} hoverOpenDelay={hoverOpenDelay} defaultIsOpen={reached === 'hover'} {...props}>
      {cloneElement(children, { ref: target })}
    </Tooltip>;
  // the wrapper only listens to its target's events
  return <span
    className={wrapper_class(className)}
    role="presentation"
    // moving across the list doesn't create tooltips
    onMouseEnter={() => { timer.current = setTimeout(() => setReached('hover'), hoverOpenDelay); }}
    onMouseLeave={() => clearTimeout(timer.current)}
    // a mouse press must end on the element it started on. Taps fire their mouse events at once, after it: they show the tooltip
    onPointerDown={event => event.pointerType !== 'touch' && clearTimeout(timer.current)}
    onFocus={event => keyboard_focus(event) && setReached('focus')}
  >
    {cloneElement(children, { tabIndex: children.props.tabIndex ?? 0 })}
  </span>;
};


// A <PopoverNext> that opens on click, e.g. a menu: the first click (or Enter, Space) creates it open.
// Its portal is only created when it opens.
export const LazyPopover = ({ children, className, ...props }) => {
  const [reached, setReached, target] = useReached();
  if (reached)
    return <PopoverNext className={className} lazy defaultIsOpen {...props}>
      {cloneElement(children, { ref: target })}
    </PopoverNext>;
  return <span className={wrapper_class(className)} role="presentation" onClick={() => setReached('click')}>
    {/* like Blueprint's target */}
    {cloneElement(children, { 'aria-haspopup': props.popupKind ?? 'menu', 'aria-expanded': false })}
  </span>;
};
