// Comfortable or compact: how lists of commits and run cards look. Users choose it above them, or in Settings → Preferences.
import { SegmentedControl, Tooltip } from "@blueprintjs/core";

import { usePrefsStore, useCommitListDensity, useOutputCardDensity } from "../stores/prefs";


export const density_options = [
  { value: 'comfortable', label: 'Comfortable', icon: 'list' },
  { value: 'compact', label: 'Compact', icon: 'list-columns' },
];

export const commit_density_help = "Comfortable: a few lines per commit. Compact: one line per commit, hover for details.";
export const card_density_help = "Comfortable: the run's tags on its name's line, more room around its visualizations. Compact: one line per run, like in the logs: its configuration as text (hover it for the tags), less room around the visualizations.";

const DensityControl = ({ label, help, value, onChange }) => <Tooltip content={<div style={{ maxWidth: 320 }}>{help}</div>} placement="left" openOnTargetFocus={false}>
  <SegmentedControl
    aria-label={label}
    size="small"
    options={density_options}
    value={value}
    onValueChange={onChange}
  />
</Tooltip>;

export const CommitListDensityControl = () => {
  const density = useCommitListDensity();
  const setDensity = usePrefsStore(state => state.setCommitListDensity);
  return <DensityControl label="Commit list density" help={commit_density_help} value={density} onChange={setDensity}/>;
};

export const OutputCardDensityControl = () => {
  const density = useOutputCardDensity();
  const setDensity = usePrefsStore(state => state.setOutputCardDensity);
  return <DensityControl label="Run cards density" help={card_density_help} value={density} onChange={setDensity}/>;
};
