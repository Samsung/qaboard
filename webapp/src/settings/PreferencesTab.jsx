// Settings → Preferences: the same controls as in the pages, in one place
import { Classes, FormGroup, Radio, RadioGroup, SegmentedControl, Switch } from "@blueprintjs/core";

import { usePrefsStore, useCommitListDensity, useOutputCardDensity, useRunNameOrigin } from "../stores/prefs";
import { density_options, commit_density_help, card_density_help } from "../components/DensityControl";
import { run_name_origin_options } from "../components/RunInfoMenu";


const theme_options = [
  { value: 'system', label: 'Same as your system', icon: 'desktop' },
  { value: 'light', label: 'Light', icon: 'flash' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];
const pixel_values_options = [
  { value: 'image', label: "The image's own values", description: 'e.g. 10-bit or float values, when the image server gives them' },
  { value: 'display', label: 'The displayed values', description: '8-bit, after the adjustments' },
  { value: 'off', label: 'None' },
];

const Section = ({ children }) => <div style={{ maxWidth: 640, marginBottom: 8 }}>{children}</div>;


export const PreferencesTab = ({ user }) => {
  const theme = usePrefsStore(state => state.theme) ?? 'system';
  const setTheme = usePrefsStore(state => state.setTheme);
  const density = useCommitListDensity();
  const setDensity = usePrefsStore(state => state.setCommitListDensity);
  const card_density = useOutputCardDensity();
  const setCardDensity = usePrefsStore(state => state.setOutputCardDensity);
  const run_name_origin = useRunNameOrigin();
  const setRunNameOrigin = usePrefsStore(state => state.setRunNameOrigin);
  const pixel_values = usePrefsStore(state => state.imagePixelValues);
  const setPixelValues = usePrefsStore(state => state.setImagePixelValues);
  const hide_shared = usePrefsStore(state => state.hide_shared_settings);
  const toggleHideShared = usePrefsStore(state => state.toggleHideSharedSettings);
  const shorten_long = usePrefsStore(state => state.shorten_long_settings !== false);
  const toggleShortenLong = usePrefsStore(state => state.toggleShortenLongSettings);
  const nb_favorites = usePrefsStore(state => Object.values(state.favorites).filter(Boolean).length);

  return <section aria-label="Preferences">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 640 }}>
      {user?.is_logged
        ? "Your preferences are saved in your account: they follow you in every browser where you sign in. Whether the sidebar is collapsed stays per browser."
        : "Your preferences are saved in this browser. Sign in to keep them in every browser."}
    </p>
    <Section>
      <FormGroup label="Theme">
        <SegmentedControl aria-label="Theme" options={theme_options} value={theme} onValueChange={setTheme} inline/>
      </FormGroup>
      <FormGroup label="Lists of commits" helperText={commit_density_help}>
        <SegmentedControl aria-label="Commit list density" options={density_options} value={density} onValueChange={setDensity} inline/>
      </FormGroup>
      <FormGroup label="Run cards" helperText={card_density_help}>
        <SegmentedControl aria-label="Run cards density" options={density_options} value={card_density} onValueChange={setCardDensity} inline/>
      </FormGroup>
      <FormGroup label="Batch and database in runs' names" helperText="Runs' names can start with the batch and the database of their input, in the run cards, the logs and the tables.">
        <RadioGroup selectedValue={run_name_origin} onChange={e => setRunNameOrigin(e.currentTarget.value)}>
          {run_name_origin_options.map(option => <Radio
            key={option.value}
            value={option.value}
            labelElement={<>{option.label}{option.description && <span className={Classes.TEXT_MUTED}> · {option.description}</span>}</>}
          />)}
        </RadioGroup>
      </FormGroup>
      <FormGroup label="Values written on the pixels" helperText="When you zoom in on images. Press p in the image viewer to toggle them.">
        <RadioGroup selectedValue={pixel_values} onChange={e => setPixelValues(e.currentTarget.value)}>
          {pixel_values_options.map(option => <Radio
            key={option.value}
            value={option.value}
            labelElement={<>{option.label}{option.description && <span className={Classes.TEXT_MUTED}> · {option.description}</span>}</>}
          />)}
        </RadioGroup>
      </FormGroup>
      <FormGroup label="Runs' settings" helperText="Click a shortened setting in any run to switch between shortened and full settings.">
        <Switch checked={!!hide_shared} onChange={toggleHideShared} label="Hide the settings all runs share, show them once above the runs"/>
        <Switch checked={shorten_long} onChange={toggleShortenLong} label="Shorten long settings with …, e.g. paths, commands and lists. Hover them to see them in full"/>
      </FormGroup>
      <FormGroup label="Pinned projects">
        <span className={Classes.TEXT_MUTED}>
          {nb_favorites ? `You pinned ${nb_favorites} project${nb_favorites === 1 ? '' : 's'} on top of the projects list.` : "Pin projects on top of the projects list with their star."}
        </span>
      </FormGroup>
    </Section>
  </section>;
};

export default PreferencesTab;
