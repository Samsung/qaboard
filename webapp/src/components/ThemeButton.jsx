// Switches between the system, light and dark themes, see src/theme.js
import { Button, Tooltip } from "@blueprintjs/core";
import { usePrefsStore } from "../stores/prefs";
import { themes } from "../theme";

const labels = { system: "Same as your system", light: "Light", dark: "Dark" };
const default_icons = { system: "desktop", light: "flash", dark: "moon" };

// Pages that bundle only the icons they use (the file browser) pass them as elements
export const ThemeButton = ({ className, style, icons = default_icons }) => {
  const theme = usePrefsStore(state => state.theme) ?? "system";
  const setTheme = usePrefsStore(state => state.setTheme);
  const next = themes[(themes.indexOf(theme) + 1) % themes.length];
  return <Tooltip content={<span>Theme: <strong>{labels[theme]}</strong><br/>Click for: {labels[next]}</span>}>
    <Button
      variant="minimal"
      size="small"
      icon={icons[theme]}
      aria-label={`Theme: ${labels[theme]}. Switch to ${labels[next]}`}
      onClick={() => setTheme(next)}
      className={className}
      style={style}
    />
  </Tooltip>
}

export default ThemeButton;
