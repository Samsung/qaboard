// At the top of the commit page: the settings all runs share, and how their configurations differ from the reference.
import { useMemo, useState } from "react";
import styled from "styled-components";
import { Button, Classes, Icon, Intent, Switch, Tag } from "@blueprintjs/core";

import { usePrefsStore } from "../stores/prefs";
import { copyWithToast } from "../utils/clipboard";
import { summarize_changes, reference_pairs } from "./tokens";
import { SettingText, SharedSettings, useSharedConfiguration, useHideSharedSettings } from "./ConfigurationsTags";


const Box = styled.div`
  background: var(--qa-surface);
  border: 1px solid var(--qa-border);
  border-radius: 4px;
  padding: 8px 12px;
  margin-bottom: 10px;
`;

const Row = styled.div`
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 3px 0;
  .label {
    flex: 0 0 120px;
    white-space: nowrap;
  }
  .values {
    flex: 1 1 auto;
    min-width: 0;
  }
  .actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
`;

const op_tags = {
  added: { intent: Intent.SUCCESS, icon: 'plus' },
  removed: { intent: Intent.DANGER, icon: 'minus' },
  changed: { intent: Intent.WARNING },
};

const shown_settings = 8;
const shown_changes = 4;

const setting_line = token => token.kind === 'param' ? `${token.key}: ${token.display}` : token.text;

// The switch is also in the View options panel
export const HideSharedSwitch = ({ label = "Hide them in each run", style }) => {
  const hide = useHideSharedSettings();
  const toggle = usePrefsStore(state => state.toggleHideSharedSettings);
  return <Switch checked={hide} onChange={toggle} label={label} style={{ marginBottom: 0, ...style }} />;
};


// The settings all runs share
export const SharedRow = ({ shared, filtered }) => {
  const [expanded, setExpanded] = useState(false);
  const more = shared.tokens.length - shown_settings;
  return <Row>
    <span className="label">
      <Icon icon="people" size={14} className={Classes.TEXT_MUTED} style={{ marginRight: 6 }} />
      <strong>All {shared.runs} {filtered ? 'filtered ' : ''}runs</strong>
    </span>
    <span className="values">
      <SharedSettings tokens={shared.tokens} limit={expanded ? undefined : shown_settings} />
      {more > 0 && <Tag round minimal interactive icon={expanded ? 'chevron-up' : 'more'} onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Show less' : `${more} more`}
      </Tag>}
    </span>
    <span className="actions">
      <Button
        size="small"
        variant="minimal"
        icon="duplicate"
        title="Copy the settings all runs share"
        onClick={() => copyWithToast(shared.tokens.map(setting_line).join('\n'), { what: 'the shared settings' })}
      />
      {shared.collapse && <HideSharedSwitch />}
    </span>
  </Row>;
};


// How the runs' configurations differ from their reference run's
const ReferenceRow = ({ compared, pairs, ambiguous }) => {
  const [expanded, setExpanded] = useState(false);
  const changes = useMemo(() => summarize_changes(pairs), [pairs]);
  const shown = expanded ? changes : changes.slice(0, shown_changes);
  const more = changes.length - shown.length;
  return <Row>
    <span className="label">
      <Icon icon="comparison" size={14} className={Classes.TEXT_MUTED} style={{ marginRight: 6 }} />
      <strong>vs. reference</strong>
    </span>
    {pairs.length === 0
      ? <span className={`values ${Classes.TEXT_MUTED}`}>
          <Icon icon="tick" intent={Intent.SUCCESS} size={12} style={{ marginRight: 5 }} />
          Each run is compared to a reference run with the same settings.
        </span>
      : <span className="values">
          <span style={{ marginRight: 8 }}>
            {pairs.length === compared ? `All ${compared}` : `${pairs.length} of ${compared}`} runs
            are compared to a reference run with other settings:
          </span>
          {shown.map(change => <span key={`${change.op}${change.token.full}${change.ref?.full}`} style={{ whiteSpace: 'nowrap', marginRight: 10 }}>
            <Tag round minimal {...op_tags[change.op]} style={{ marginRight: 4, maxWidth: '100%' }}>
              <SettingText d={change} />
            </Tag>
            <span className={Classes.TEXT_MUTED}>{change.runs === pairs.length ? (pairs.length > 1 ? 'in all' : '') : `in ${change.runs}`}</span>
          </span>)}
          {(more > 0 || expanded) && <Tag round minimal interactive icon={expanded ? 'chevron-up' : 'more'} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : `${more} other ${more === 1 ? 'change' : 'changes'}`}
          </Tag>}
          {ambiguous > 0 && <span className={Classes.TEXT_MUTED} style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
            <Icon icon="git-branch" size={12} intent={Intent.WARNING} style={{ marginRight: 5 }} />
            {ambiguous === 1 ? '1 run' : `${ambiguous} runs`} had several reference runs with as many different settings:
            we picked the ones with the closest values. Hover their Config tag to know more.
          </span>}
        </span>}
  </Row>;
};


// Shown when it helps: with long configurations shared by all runs, or runs compared to references with other configurations
export const ConfigurationOverview = ({ new_batch }) => {
  const shared = useSharedConfiguration();
  const { compared, pairs, ambiguous } = useMemo(() => reference_pairs(new_batch), [new_batch]);
  const show_shared = !!shared?.collapse;
  if (!show_shared && pairs.length === 0) return null;
  const filtered = (new_batch?.filtered?.outputs?.length ?? 0) < Object.keys(new_batch?.outputs ?? {}).length;
  return <Box aria-label="Configurations">
    {show_shared && <SharedRow shared={shared} filtered={filtered} />}
    {compared > 0 && <ReferenceRow compared={compared} pairs={pairs} ambiguous={ambiguous} />}
  </Box>;
};
