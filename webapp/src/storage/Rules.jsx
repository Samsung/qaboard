// What deletes results automatically, when, and what it keeps: the schedules admins set up, with the project's qaboard.yaml.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Callout, Card, Classes, Collapse, Icon, Intent, PopoverNext, Tag } from "@blueprintjs/core";

import { Link } from "../router";
import { Time } from "../settings/format";
import { useUser } from "../hooks";
import { rulesQuery } from "./api";


const rule_icons = { garbage_collect: 'time', hard_delete: 'trash', delete_artifacts: 'box' };

const Rule = ({ rule }) => <div style={{ display: 'flex', gap: 10, marginBottom: 10 }} data-testid="deletion-rule">
  <Icon icon={rule_icons[rule.kind] ?? 'trash'} className={Classes.TEXT_MUTED} style={{ marginTop: 2 }}/>
  <div>
    <strong>{rule.title}</strong>
    {rule.dry_run && <Tag minimal style={{ marginLeft: 6 }}>Dry run: nothing is deleted yet</Tag>}
    <div>{rule.detail} {rule.keeps}</div>
    <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
      Runs {rule.when}{rule.next_run_at && <>, next <Time iso={rule.next_run_at}/></>}
      {rule.projects !== '*' && <> · projects: <code>{rule.projects}</code></>}
    </div>
  </div>
</div>;

// The rules, for a project or all of them
export const RulesList = ({ project, data }) => {
  const rules = data?.rules ?? [];
  const settings = data?.settings ?? {};
  if (rules.length === 0) return <p className={Classes.TEXT_MUTED} style={{ margin: 0 }}>
    Nothing deletes {project ? "this project's" : 'the'} results automatically: they stay until someone deletes them.
  </p>;
  return <>
    {rules.map((rule, i) => <Rule key={i} rule={rule}/>)}
    {project && settings.after && <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: 0 }}>
      The project's <code>qaboard.yaml</code> sets <code>storage.garbage.after: {settings.after}</code>.
    </p>}
  </>;
};

// A card on the storage page. Several rules are summed up in a line: they'd push the storage usage down
export const Rules = ({ project }) => {
  const { data, isPending, error } = useQuery(rulesQuery(project));
  const [expanded, setExpanded] = useState(false);
  if (isPending || error) return null;
  const rules = data?.rules ?? [];
  const collapsible = rules.length > 1;
  const shown = !collapsible || expanded;
  const next = rules.map(rule => rule.next_run_at).filter(Boolean).sort()[0];
  return <Card compact style={{ marginBottom: 20 }} aria-label="Deletion rules" data-testid="deletion-rules">
    <h5 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: shown ? undefined : 0 }}>
      <Icon icon="automatic-updates"/>
      What QA-Board deletes automatically{project ? <> in {project}</> : ''}
      {collapsible && <Button
        variant="minimal" size="small" style={{ marginLeft: 'auto' }}
        icon={shown ? 'chevron-up' : 'chevron-down'} text={shown ? 'Hide' : `Show the ${rules.length} rules`}
        aria-expanded={shown} onClick={() => setExpanded(!shown)}
      />}
    </h5>
    {!shown && <div className={`${Classes.TEXT_MUTED} ${Classes.TEXT_OVERFLOW_ELLIPSIS}`} style={{ fontSize: 13, marginTop: 4 }} data-testid="deletion-rules-summary">
      {[...new Set(rules.map(rule => rule.title))].join(' · ')}
      {next && <>, next <Time iso={next}/></>}
    </div>}
    <Collapse isOpen={shown}><RulesList project={project} data={data}/></Collapse>
  </Card>;
};

// "Results deleted after 1 month": a button on the project's pages, that opens the rules
export const RulesButton = ({ project }) => {
  const { is_logged } = useUser();
  const { data } = useQuery({ ...rulesQuery(project), enabled: !!is_logged && !!project });
  const rules = data?.rules ?? [];
  if (!is_logged || !data) return null;
  const garbage = rules.find(rule => rule.kind === 'garbage_collect' && !rule.dry_run);
  const text = garbage ? `Results deleted after ${garbage.after}` : rules.length ? 'Deletion rules' : 'Results kept';
  return <PopoverNext
    placement="bottom-end"
    content={<div style={{ padding: 15, maxWidth: 'min(480px, calc(100vw - 40px))' }}>
      <h5 className={Classes.HEADING}>What QA-Board deletes automatically</h5>
      <RulesList project={project} data={data}/>
      {garbage && <Callout intent={Intent.PRIMARY} icon="lock" style={{ marginTop: 8 }}>
        To keep a batch, make it a milestone.
      </Callout>}
      <div style={{ marginTop: 10 }}><Link to={`/storage/batches?project=${encodeURIComponent(project)}`}>How much storage your runs use here</Link></div>
    </div>}
  >
    <Button variant="minimal" size="small" icon={garbage ? 'time' : 'automatic-updates'} text={text} aria-label="Deletion rules"/>
  </PopoverNext>;
};

export default Rules;
