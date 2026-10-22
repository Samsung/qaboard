// What deletes results automatically, when, and what it keeps: the schedules admins set up, with the project's qaboard.yaml.
import { useQuery } from "@tanstack/react-query";
import { Button, Callout, Card, Classes, Icon, Intent, PopoverNext, Tag } from "@blueprintjs/core";

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

// A card on the storage page
export const Rules = ({ project }) => {
  const { data, isPending, error } = useQuery(rulesQuery(project));
  if (isPending || error) return null;
  return <Card compact style={{ marginBottom: 20 }} aria-label="Deletion rules" data-testid="deletion-rules">
    <h5 className={Classes.HEADING}>
      <Icon icon="automatic-updates" style={{ marginRight: 6 }}/>
      What QA-Board deletes automatically{project ? <> in {project}</> : ''}
    </h5>
    <RulesList project={project} data={data}/>
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
