// Props that make something users click, e.g. a <Card interactive>, a button for keyboards and screen readers too:
// it gets the focus with Tab, and Enter or Space press it. <Card interactive {...pressable(() => open())}>
export const pressable = onPress => ({
  role: 'button',
  tabIndex: 0,
  onClick: onPress,
  onKeyDown: event => {
    // not when users type in, or press, something inside
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onPress(event);
  },
});
