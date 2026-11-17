// At the top of the commit page: the settings all runs share, how their configurations differ from the reference, and
// how they found their reference run when there's something to know (src/matching/ReferenceMatching.jsx).
import { useMemo, useState } from "react";
import styled from "styled-components";
import { Button, Classes, Icon, Intent, Switch, Tag } from "@blueprintjs/core";

import { usePrefsStore } from "../stores/prefs";
import { copyWithToast } from "../utils/clipboard";
import { summarize_changes, reference_pairs } from "./tokens";
import { SettingTag, SharedSettings, useSharedConfiguration, useHideSharedSettings, useShortenLongSettings } from "./ConfigurationsTags";
import { ReferenceMatchingActions, ReferenceMatchingValues, useReferenceMatching } from "../matching/ReferenceMatching";


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

const shown_settings = 8;
const shown_changes = 4;

const setting_line = token => token.kind === 'param' ? `${token.key}: ${token.display}` : token.text;

// The switch is also in the View options panel
export const HideSharedSwitch = ({ label = "Hide them in each run", style }) => {
  const hide = useHideSharedSettings();
  const toggle = usePrefsStore(state => state.toggleHideSharedSettings);
  return <Switch checked={hide} onChange={toggle} label={label} style={{ marginBottom: 0, ...style }} />;
};

// Also in Settings → Preferences, and clicking a shortened setting switches it
export const ShortenLongSettingsSwitch = ({ label = "Shorten long settings with …", style }) => {
  const shorten = useShortenLongSettings();
  const toggle = usePrefsStore(state => state.toggleShortenLongSettings);
  return <Switch checked={shorten} onChange={toggle} label={label} style={{ marginBottom: 0, ...style }} />;
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
const ReferenceRow = ({ compared, pairs }) => {
  const [expanded, setExpanded] = useState(false);
  const changes = useMemo(() => summarize_changes(pairs), [pairs]);
  const shown = expanded ? changes : changes.slice(0, shown_changes);
  const more = changes.length - shown.length;
  // settings shown in full can be long: they wrap
  const shorten = useShortenLongSettings();
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
          {shown.map(change => <span key={`${change.op}${change.token.full}${change.ref?.full}`} style={{ whiteSpace: shorten ? 'nowrap' : undefined, marginRight: 10 }}>
            <SettingTag d={change} style={{ marginRight: 4, marginBottom: 0 }} />
            <span className={Classes.TEXT_MUTED}>{change.runs === pairs.length ? (pairs.length > 1 ? 'in all' : '') : `in ${change.runs}`}</span>
          </span>)}
          {(more > 0 || expanded) && <Tag round minimal interactive icon={expanded ? 'chevron-up' : 'more'} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : `${more} other ${more === 1 ? 'change' : 'changes'}`}
          </Tag>}
        </span>}
  </Row>;
};


// Which reference run the runs are compared with: when runs have none, ties, or rules users set (the ties are said here)
const MatchingRow = ({ status }) => <Row>
  <span className="label">
    <Icon icon="link" size={14} className={Classes.TEXT_MUTED} style={{ marginRight: 6 }} />
    <strong>Reference runs</strong>
  </span>
  <span className="values"><ReferenceMatchingValues status={status} /></span>
  <span className="actions"><ReferenceMatchingActions status={status} /></span>
</Row>;


// Shown when it helps: with long configurations shared by all runs, runs compared to references with other
// configurations, or something to know about how runs found their reference run
export const ConfigurationOverview = ({ new_batch }) => {
  const shared = useSharedConfiguration();
  const { compared, pairs } = useMemo(() => reference_pairs(new_batch), [new_batch]);
  const matching = useReferenceMatching();
  const show_shared = !!shared?.collapse;
  if (!show_shared && pairs.length === 0 && !matching) return null;
  const filtered = (new_batch?.filtered?.outputs?.length ?? 0) < Object.keys(new_batch?.outputs ?? {}).length;
  return <Box role="region" aria-label="Configurations">
    {show_shared && <SharedRow shared={shared} filtered={filtered} />}
    {compared > 0 && (pairs.length > 0 || !matching) && <ReferenceRow compared={compared} pairs={pairs} />}
    {matching && <MatchingRow status={matching} />}
  </Box>;
};
