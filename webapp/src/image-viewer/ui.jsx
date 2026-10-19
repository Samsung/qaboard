// Small UI pieces, so that the viewer only depends on React. Styles: image-viewer.css
import { useEffect, useId, useRef, useState } from 'react';

import { ICONS } from './icons';

export const Icon = ({ icon, size = 16, className = '', style }) => {
  const paths = ICONS[icon];
  if (!paths) return null;
  return <svg className={`qiv-icon ${className}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={style}>
    {paths.map((d, i) => <path key={i} d={d} fillRule="evenodd" />)}
  </svg>;
};

export const Button = ({ icon, text, children, active = false, className = '', title, label, ...props }) =>
  <button
    type="button"
    className={`qiv-button ${active ? 'qiv-active' : ''} ${!text && !children ? 'qiv-icon-only' : ''} ${className}`}
    title={title}
    aria-label={label ?? (!text && !children ? title : undefined)}
    {...props}
  >
    {icon && <Icon icon={icon} />}
    {(text || children) && <span>{text}{children}</span>}
  </button>;

// One of a few options, e.g. the comparison mode. The left and right arrows move between options, like radio buttons
// (not up and down: users scroll the page with them).
export const Segmented = ({ options, value, onChange, label, className = '' }) => {
  const refs = useRef([]);
  const onKeyDown = (event, index) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return <div className={`qiv-segmented ${className}`} role="radiogroup" aria-label={label}>
    {options.map((option, index) => <button
      key={option.value}
      ref={element => { refs.current[index] = element; }}
      type="button"
      role="radio"
      aria-checked={option.value === value}
      tabIndex={option.value === value ? 0 : -1}
      className={`qiv-button ${option.value === value ? 'qiv-active' : ''}`}
      title={option.title}
      onClick={() => onChange(option.value)}
      onKeyDown={event => onKeyDown(event, index)}
    >
      {option.icon && <Icon icon={option.icon} />}
      <span className="qiv-segmented-label">{option.label}</span>
    </button>)}
  </div>;
};

export const Select = ({ value, options, onChange, label, title, className = '' }) =>
  <span className={`qiv-select ${className}`}>
    <select value={value} onChange={event => onChange(event.target.value)} aria-label={label} title={title}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <Icon icon="chevron-down" size={12} />
  </span>;

// A button that opens a panel. It closes with Escape, or a click elsewhere.
export const Popover = ({ button, children, align = 'start', className = '', open: controlled, onOpenChange }) => {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = value => {
    setUncontrolled(value);
    onOpenChange?.(value);
  };
  const root = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onPointerDown = event => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      root.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  });
  return <span className={`qiv-popover-root ${className}`} ref={root}>
    {button({ onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-controls': id, active: open })}
    {open && <div id={id} className={`qiv-popover qiv-popover-${align}`} role="dialog">
      {typeof children === 'function' ? children({ close: () => setOpen(false) }) : children}
    </div>}
  </span>;
};

export const MenuItem = ({ icon, text, label, title, active, disabled, onClick, href }) => {
  const content = <>
    <Icon icon={icon ?? 'tick'} className={icon || active ? '' : 'qiv-hidden'} />
    <span className="qiv-menu-text">{text}</span>
    {label && <span className="qiv-menu-label">{label}</span>}
  </>;
  if (href)
    return <a className="qiv-menu-item" href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>{content}</a>;
  return <button type="button" className={`qiv-menu-item ${active ? 'qiv-active' : ''}`} role="menuitem" title={title} disabled={disabled} onClick={onClick}>{content}</button>;
};

export const MenuDivider = ({ title }) => title
  ? <div className="qiv-menu-title">{title}</div>
  : <hr className="qiv-menu-divider" />;

export const Spinner = ({ size = 14, label = 'Loading' }) =>
  <span className="qiv-spinner" style={{ width: size, height: size }} role="progressbar" aria-label={label} />;

// A primitive of the display adjustments' SVG filter (adjustments.js filterPrimitives)
export const FilterPrimitive = ({ primitive }) => {
  const { type, attributes, functions } = primitive;
  if (type === 'feComponentTransfer')
    return <feComponentTransfer>
      {functions.map(({ channel, ...f }) => {
        const Func = `feFunc${channel}`;
        return <Func key={channel} {...f} />;
      })}
    </feComponentTransfer>;
  const Element = type;
  return <Element {...attributes} />;
};
