// In the commit bars: a star to save the results shown (commit, batch, filter) as a milestone,
// filled when they are one, with the milestone's name next to it.
import { Button, Classes, Colors, Icon, Position, Tag, Tooltip } from "@blueprintjs/core";

import { milestone_name, milestones_of } from "./api";
import { useMilestones } from "./hooks";
import { openMilestoneDialog } from "./MilestoneDialog";


export const CommitMilestoneButton = ({ project, project_shown, commit, batch, filter, runs }) => {
  const index = useMilestones(project);
  const results_project = project_shown ?? project;
  const selection = { project: results_project, commit: commit?.id, batch: batch?.label ?? 'default' };
  const exact = milestones_of(index, { ...selection, filter: filter ?? '' });
  const others = milestones_of(index, selection).filter(m => !exact.includes(m));
  const milestone = exact[0];
  const disabled = !commit?.id;

  const open = () => milestone
    ? openMilestoneDialog({ project, milestone })
    : openMilestoneDialog({
        project,
        runs,
        target: { commit, batch: selection.batch, filter: filter ?? '', commit_project: results_project !== project ? results_project : null },
      });
  const tooltip = milestone
    ? <span>Milestone: <strong>{milestone_name(milestone)}</strong>. {milestone.can_edit ? 'Click to edit it, copy its link…' : 'Click for details, its link…'}</span>
    : <span style={{ display: 'inline-block', maxWidth: 280 }}>
        Save as a milestone: keep these results (this batch{filter ? ' and filter' : ''}) to compare with later.
        {others.length > 0 && <><br/><em>This batch has {others.length} milestone{others.length > 1 ? 's' : ''} with another filter: {others.map(milestone_name).join(', ')}.</em></>}
      </span>;
  return <>
    {/* the focus comes back to the button when the dialog closes: that shouldn't open the tooltip */}
    <Tooltip content={tooltip} position={Position.BOTTOM} openOnTargetFocus={false} disabled={disabled}>
      <Button
        variant="minimal"
        style={{ marginRight: milestone ? 2 : 5 }}
        onClick={open}
        disabled={disabled}
        aria-label={milestone ? `Milestone: ${milestone_name(milestone)}` : "Save as a milestone"}
      >
        <Icon icon={milestone ? (milestone.shared ? 'crown' : 'star') : 'star-empty'} color={milestone ? Colors.GOLD4 : undefined}/>
      </Button>
    </Tooltip>
    {!!milestone && <Tag
      minimal
      interactive
      onClick={open}
      className="commit-header-optional"
      title={exact.length > 1 ? exact.map(milestone_name).join(', ') : milestone_name(milestone)}
      style={{ alignSelf: 'center', marginRight: 6, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {milestone_name(milestone)}{exact.length > 1 && <span className={Classes.TEXT_MUTED}> +{exact.length - 1}</span>}
    </Tag>}
  </>;
};
