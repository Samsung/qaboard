import React, { useState } from "react";
import { DateTime } from 'luxon';
import { post } from "axios";

import {
  Colors,
  Classes,
  Intent,
  Icon,
  Tag,
  Position,
  Menu,
  MenuItem,
  H5,
  TextArea,
  Button,
  Switch,
  FormGroup,
  InputGroup,
  ControlGroup,
  HTMLSelect,
  Tooltip,
  Popover,
  Alert,
  Toaster,
} from "@blueprintjs/core";

import { updateMilestones, fetchProjects } from "../actions/projects";
import { match_query } from "../utils";

const toaster = Toaster.create();


const milestone_key = (project, commit, batch) => `${project}/${commit.id}/${batch?.label ?? 'default'}`
const has_milestones = ({commit, project, project_data, batch}) => {
  if (commit === undefined || commit == null)
    return false
  const milesones = project_data?.data?.milestones ?? {}
  const milestone_key = `${project}/${commit.id}/${batch?.label ?? ''}`
  return Object.keys(milesones).some(k => k.startsWith(milestone_key))
}
const milestone_type = ({ commit, project_shown, project_data, batch }) => {
  if (commit === undefined || commit === null ||
      project_shown=== undefined || project_shown=== null  )
      return 'none'
  const key = milestone_key(project_shown, commit, batch)
  const shared_milestones = project_data?.data?.milestones ?? {}
  if (key in shared_milestones)
    return 'shared';
  const private_milestones = project_data.milestones ?? {}
  if (key in private_milestones)
    return 'private';
  return 'none';
}

// FIXME: Right now we can only have 1 filter per commit/batch, because it's not in the key...
//        The design is really bad. Instead we could use uuids, or just have a list of milestones
//        that we filter for match on project+commit+batch+filter
//        It requires a migration, so let's leave it for later...

const MilestonesMenu = ({project, milestones, title, icon, onSelect, type}) => {
  const [filter, setFilter] = useState('');
  const [orderBy, setOrderBy] = useState("date ↓");

  const has_milestones = Object.keys(milestones).length > 0;
  const matcher = match_query(filter)
  const sortWeight =  orderBy.includes("↓") ? -1 : 1
	const milestones_menu_items = has_milestones
      ? (Object.values(milestones)
          .filter(m => matcher(`${m.project} ${m.commit} ${m.batch} ${m.filter} ${m.label} ${m.notes}`))
          .sort( (m0, m1) => sortWeight * (new Date(m0.date) - new Date(m1.date)))
         || [])
         .map(  (m, idx) => <MilestoneMenu project={project} icon={icon} key={`${type}-${idx}`} milestone={m} onSelect={onSelect} /> )
      : <></>
    return <>
      {(!!title && has_milestones) && <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>{title}</h6></li>}
      {Object.keys(milestones).length > 1 &&
          <ControlGroup>
            <InputGroup
              placeholder="filter milestones by label, branch, comment..."
              leftIcon="filter"
              value={filter}
              className={filter === '' ? undefined : Intent.PRIMARY}
              onChange={e => {
                setFilter(e.target.value)
              }}
              fill
            />
            <HTMLSelect
              onChange={e => {
                setOrderBy(e.currentTarget.value)
              }}
              options={["date ↓", "date ↑"]}
              value={orderBy}
            />
          </ControlGroup>
        }
      {milestones_menu_items}
    </>
}


const MilestoneMenu = ({ project, milestone, onSelect, icon }) => {
  const { commit: commit_id, batch, filter, label, notes, date } = milestone;
  const has_filter = !!filter && filter.length > 0;
  const has_label = !!label && label.length > 0;
  const has_notes = !!notes && notes.length > 0;
  const has_batch = !!batch && milestone.batch !== 'default';
  return <MenuItem
    text={<>
      {has_label && <>{label}<br/></>}
      {!!date && <span className={Classes.TEXT_MUTED} title={date}>
        set {DateTime.fromJSDate(new Date(date)).toRelative()}
      </span>}
    </>}
    icon={<Icon icon={icon || "star"} style={{color: Colors.GOLD4}} />}
    label={<>
      {(!!milestone.project && milestone.project !== project) && <Tag icon="git-repo" style={{marginRight: '5px'}}>{milestone.project}</Tag>}
      {has_batch && <Tag minimal style={{marginRight: '5px'}} icon="layout-skew-grid">{batch}</Tag>}
      {has_filter && <Tag minimal style={{marginRight: '5px'}} icon="filter">{filter}</Tag>}
      {!!milestone.branch && <Tag minimal icon="git-branch" style={{marginRight: '5px'}}>{milestone.branch}</Tag>}
      {!!commit_id && <Tag minimal icon="git-commit" style={{marginRight: '5px'}}>{commit_id.slice(0, 8)}</Tag>}
      {has_notes && <Tooltip position="right">
        <Tag icon="more" style={{marginRight: '5px'}}/>
        <pre>{notes}</pre>
      </Tooltip>}
    </>}
    onClick={() => !!onSelect && onSelect(milestone)}
  />
}





class CommitMilestoneEditor extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_shared: false,
      previous_milestone: {},
      overwrite_milestone: {},
      // TODO: how exactly do we use current/previous?
      // FIXME: we should keep proper "milesone" objects for the current milestone
      //        do we even need the previous milestone?
      date: new Date(),
      notes: '',
      label: '',
      // we ask for confirmation when users delete/overwrite a milestone
      show_alert_remove: false,
      show_alert_overwrite: false,
    };
  }

  render() {
    const {
    	is_shared,
    	label,
    	previous_milestone,
    	notes,
    	overwrite_milestone,
    	show_alert_remove,
    	show_alert_overwrite,
    } = this.state;
    const type = milestone_type(this.props);
    const icon = type === 'none' ? 'star-empty' : (type === 'shared' ? 'crown' : 'star');
    const color = type === 'none' ? undefined : Colors.GOLD4;

    const popover_body = <div>
      <H5>Milestone Info</H5>
      <Switch
        label='Shared'
        checked={is_shared}
        style={{ width: "200px" }}
        onChange={this.toggleSharedButton}
      />
      <FormGroup inline label="Label" labelInfo="(optional)" labelFor="text-input">
        <InputGroup
          id="text-input"
          value={label}
          style={{ width: "200px" }}
          onChange={this.update('label')}
        />
      </FormGroup>
      <FormGroup inline label="Notes" labelFor="text-input" labelInfo="(optional)">
        <TextArea onChange={this.update('notes')} value={notes} style={{ width: "200px" }} />
      </FormGroup>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 30 }}>
        {(type !== 'none') && <>
          <Button
            text="Delete"
            onClick={() => this.setState({ show_alert_remove: true })}
            intent={Intent.DANGER}
            style={{ marginRight: 50 }}
          />
          <Alert
            Button className={Classes.POPOVER_DISMISS}
            canEscapeKeyCancel
            cancelButtonText="Cancel"
            confirmButtonText="Delete"
            icon="trash"
            intent={Intent.DANGER}
            isOpen={show_alert_remove}
            onCancel={() => this.setState({ show_alert_remove: false })}
            onConfirm={this.deleteMilestone}
            style={{width: '1200px', maxWidth: "fit-content"}}
          >
            <p>Are you sure you want to delete this milestone?
              <Menu>
                <MilestoneMenu milestone={previous_milestone}/>
              </Menu>
            </p>
          </Alert>
        </>}
        <Button className={Classes.POPOVER_DISMISS} text="Save" intent={Intent.PRIMARY} onClick={this.saveMilestoneMaybeAskForConfirmation} />
      </div>
    </div>

    return <>
      <Popover
        content={popover_body}
        position={Position.RIGHT}
        popoverClassName={Classes.POPOVER_CONTENT_SIZING}
      >
        <Tooltip content={type !== 'none' ? "Edit Milestone" : "Save as Milestone"} position={Position.BOTTOM} >
          <Button minimal style={{ marginRight: '5px' }} onClick={this.updateData}
          >
            <Icon icon={icon} color={color} />
          </Button>
        </Tooltip>
      </Popover>
      <Alert
        className={Classes.POPOVER_DISMISS}
        canEscapeKeyCancel
        cancelButtonText="Cancel"
        confirmButtonText="Overwrite"
        icon="warning-sign"
        intent={Intent.PRIMARY}
        isOpen={show_alert_overwrite}
        onCancel={() => this.setState({ show_alert_overwrite: false })}
        onConfirm={this.saveMilestone}
        style={{width: null, }}
      >
        <p>A similar shared milestone already exist: <Menu><MilestoneMenu icon="crown" milestone={overwrite_milestone}/></Menu>.</p>
        <p>Would you like to overwrite it?</p>
      </Alert>
    </>
  }


  // TODO: We really could do all that in ComponentDidMount/ComponentDidUpdate
  // it would allow us some fine handling of the label/notes, we should keep them without needing to save
  updateData = () => {
    const { commit, project_shown, project_data, batch } = this.props;
    const key = milestone_key(project_shown, commit, batch)
 
    const type = milestone_type(this.props)
    if (type === 'none') {
      this.setState({
        date: new Date(),
        label: '',
        notes: '',
        is_shared: true,
      })      
    }
    else if (type === 'private' || type === 'shared') {
        const private_milestones = project_data.milestones ?? {};
        const shared_milestones = project_data?.data?.milestones ?? {}
        const milestones = type === 'private' ? private_milestones : shared_milestones
        const matching_milestone = milestones[key]
        this.setState({
          previous_milestone: {...matching_milestone},
          label: matching_milestone.label,
          notes: matching_milestone.notes,
          is_shared: type === 'shared',
        })
    }
  }

  updateShared = ({key, milestone, should_delete}) => {
    const data = {
      project: this.props.project,
      key,
      milestone,
      "delete": should_delete ? 'true' : 'false',
    };
    post("/api/v1/project/milestones/", data)
      .then(res => {
        toaster.show({
          message: !!should_delete ? 'Deleted' : 'Saved.',
          intent: Intent.PRIMARY,
          timeout: 4500,
        });
        // Causes the projects data to update, and the new milestone to be visible
        this.props.dispatch(fetchProjects())
      })
      .catch(error => {
        toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 });
      })
  }

  saveMilestone = () => {
    // FIXME: can we avoid this? It really should happen only if a milestone switches between shared<=>private
    //        otherwise we can just update

    // TODO: we should first update then remove, or update in place...
    // Remove if the milestone already exists
    this.deleteMilestone();

    const { commit, dispatch, project, project_shown, project_data, batch, filter } = this.props;
    const { date, label, notes, is_shared } = this.state

    let milestone = {
      label,
      notes,
      commit: commit.id,
      branch: commit.branch,
      batch: batch.label,
      filter,
      date,
    }
    if (project !== project_shown)
      milestone.project = project_shown
    const key = milestone_key(project_shown, commit, batch)

    if (is_shared)
      this.updateShared({key, milestone});
    else {
      const private_milestones = project_data.milestones || {};
      private_milestones[key] = milestone;
      dispatch(updateMilestones(project, private_milestones));
      toaster.show({
        message: "Saved",
        intent: Intent.SUCCESS,
        timeout: 5000
      });
    }
  }

  saveMilestoneMaybeAskForConfirmation = () => {
    const { commit, project_shown, project_data, batch } = this.props;
    const key = milestone_key(project_shown, commit, batch)
    const shared_milestones = project_data?.data?.milestones ?? {}
    if (key in shared_milestones)
      this.setState({
        show_alert_overwrite: true,
        overwrite_milestone: shared_milestones[key],
      });
    else
      this.saveMilestone();
  }

  deleteMilestone = () => {
    const { dispatch, commit, project, project_shown, project_data, batch } = this.props;
    const key = milestone_key(project_shown, commit, batch)
    switch (milestone_type(this.props)) {
      case "private":
        const milestones = project_data.milestones || [];
        delete milestones[key];
        dispatch(updateMilestones(project, milestones))
        toaster.show({
          message: "Deleted.",
          intent: Intent.PRIMARY,
          timeout: 4000
        });
        break;
      case "shared":
        this.updateShared({key, should_delete: true});
        break;
      default: // case 'none'
        return;
    }

    this.setState({
      show_alert_remove: false,
      show_alert_overwrite: false,
    });
  }


  toggleSharedButton = () => {
    this.setState({
      is_shared: !this.state.is_shared,
    })
  }

  update = name => event => {
    this.setState({
      [name]: event.target.value
    })
  }


}


export { MilestonesMenu, CommitMilestoneEditor, has_milestones };
