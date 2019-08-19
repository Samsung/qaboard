import React from "react";
import Moment from "react-moment";
import { post } from "axios";

import {
  Colors,
  Classes,
  Intent,
  Icon,
  Tag,
  Position,
  Menu,
  H5,
  TextArea,
  Button,
  Switch,
  FormGroup,
  InputGroup,
  Tooltip,
  Popover,
  Alert,
  Toaster,
} from "@blueprintjs/core";

import { updateMilestones, fetchProjects } from "../actions/projects";
import { shortId } from "../utils";

const toaster = Toaster.create();



const MilestonesMenu = ({milestones, title, icon, onSelect, type}) => {
	const has_milestones = Object.keys(milestones).length > 0;
	const milestones_menu_items = has_milestones
      ? (Object.values(milestones)
          .sort( (m0, m1) => new Date(m1.date) - new Date(m0.date))
         || [])
         .map(  (m, idx) => <MilestoneMenu icon={icon} key={`${type}-${idx}`} milestone={m} onSelect={onSelect} /> )
      : <></>
    return <>
      {(!!title && has_milestones) && <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>{title}</h6></li>}
      {milestones_menu_items}
    </>
}


const MilestoneMenu = ({ milestone, onSelect, icon }) => {
  const { commit: commit_id, batch, label, notes, date } = milestone;
  const has_label = !!label && label.length > 0;
  const has_notes = !!notes && notes.length > 0;
  const has_batch = !!batch && milestone.batch !== 'default';
  return <Menu.Item
    text={<>
      {has_label && <>{label}<br/></>}
      <Tooltip>
        <span className={Classes.TEXT_MUTED}>set <Moment fromNow date={date} /></span>
        <span>{date}</span>
      </Tooltip>
    </>}
    icon={<Icon icon={icon || "star"} style={{color: Colors.GOLD4}} />}
    label={<>
      {has_batch && <Tag minimal icon="layout-skew-grid">{!!milestone.batch && milestone.batch}</Tag>}
      <Tag minimal icon="git-branch" style={{marginLeft: '5px'}}>{!!milestone.branch && milestone.branch}</Tag>
      <Tag minimal icon="git-commit" style={{marginLeft: '5px'}}>{!!commit_id && commit_id.slice(0, 8)}</Tag>
      {has_notes && <Tooltip>
        <Tag icon="more" style={{marginLeft: '5px'}}/>
        <span>{notes}</span>
      </Tooltip>}
    </>}
    onClick={() => onSelect(milestone)}
  />
}


const milestone_key = (project, commit, batch) => `${project}/${commit.id}/${batch}`



class CommitMilestoneEditor extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_shared: false,
      notes: '',
      // TODO: how exactly do we use current/previous?
      // FIXME: we should keep proper "milesone" objects for the current milestone
      //        do we even need the previous milestone?
      current_label: '',
      previous_label: '',
      overwrite_shared_label: '',
      // we ask for confirmation when users delete/overwrite a milestone
      show_alert_remove: false,
      show_alert_overwrite: false,
    };
  }

  render() {
    const {
    	is_shared,
    	current_label,
    	previous_label,
    	notes,
    	overwrite_shared_label,
    	show_alert_remove,
    	show_alert_overwrite,
    } = this.state;
    const milestone_type = this.getMilestoneType();
    const icon = milestone_type === 'none' ? 'star-empty' : (milestone_type === 'shared' ? 'crown' : 'star');
    const color = milestone_type === 'none' ? undefined : Colors.GOLD4;

    const popover_body = <div>
      <H5>Milestone Info</H5>
      <Switch
        label='Shared'
        checked={is_shared}
        autoFocus
        style={{ width: "200px" }}
        onChange={this.toggleSharedButton}
      />
      <FormGroup inline label="Label" labelInfo="(optionnal)" labelFor="text-input">
        <InputGroup
          id="text-input"
          value={current_label}
          autoFocus
          style={{ width: "200px" }}
          onChange={this.update('current_label')}
          onFocus={event => event.target.select()}
        />
      </FormGroup>
      <FormGroup inline label="Notes" labelFor="text-input" labelInfo="(optionnal)">
        <TextArea onChange={this.update('notes')} value={notes} style={{ width: "200px" }} />
      </FormGroup>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 30 }}>
        {(milestone_type !== 'none') && <>
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
          >
            <p>Are you sure you want to delete <b>{previous_label}</b>?</p>
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
        <Tooltip content={milestone_type !== 'none' ? "Edit Milestone" : "Save as Milestone"} position={Position.BOTTOM} >
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
      >
        <p>A similar shared milestone already exist (<b>{overwrite_shared_label}</b>).</p><p>Would you like to overwrite it?</p>
      </Alert>
    </>
  }


  getMilestoneType = () => {
    const { commit, project, project_data, selected, type } = this.props;
    if (commit === undefined || commit === null ||
    	  project=== undefined || project=== null  )
        return 'none'
    let batch = selected[`selected_batch_${type}`];
    const key = milestone_key(project, commit, batch)
    const local_milestones = project_data.milestones || {}
    if (key in local_milestones)
    	return 'local';
    const shared_milestones = ((project_data || {}).data || {}).milestones || {}
    if (key in shared_milestones)
    	return 'shared';
    return 'none';
  }


  // TODO: We really could do all that in ComponentDidMount/ComponentDidUpdate
  // it would allow us some fine handling of the label/notes, we should keep them without needing to save
  updateData = () => {
    const { commit, project, project_data, selected, type } = this.props;
    let batch = selected[`selected_batch_${type}`];
    const key = milestone_key(project, commit, batch)

    const milestone_type = this.getMilestoneType()
    if (milestone_type === 'none') {
      this.setState({
        current_label: '',
        notes: '',
        is_shared: true,
      })      
    }
    else if (milestone_type === 'local' || milestone_type === 'shared') {
        const matching_milestone = project_data.milestones[key]
        if (!!matching_milestone) { // likely safe even without this check
          this.setState({
            current_label: matching_milestone.label,
            previous_label: matching_milestone.label,
            notes: matching_milestone.notes,
            is_shared: milestone_type === 'shared',
          })
        }
    }
  }

  updateShared = ({key, milestone, should_delete}) => {
    const data = {
      project: this.props.project,
      key,
      milestone,
      "delete": should_delete,
    };
    post("/api/v1/project/milestones", data)
      .then(res => {
        this.props.update_db(res.data);
        toaster.show({
          message: !!should_delete ? 'Deleted' : 'Saved.',
          intent: Intent.PRIMARY,
          timeout: 4500,
        });
        // Ccauses the projects data to update, and the new milestone to be visible
        this.props.dispatch(fetchProjects())
      })
      .catch(error => {
        toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 });
      })
  }

  saveMilestone = () => {
    // FIXME: can we avoid this? It really should happen only if a milestone switches between shared<=>local
    //        otherwise we can just update
    // first remove if the milestone already exists
    this.deleteMilestone();

    const { commit, dispatch, project, project_data, selected, type } = this.props;
    const { current_label, label, notes, is_shared } = this.state

    const batch = selected[`selected_batch_${type}`];
    const milestone = {
      label: current_label,
      notes: notes,
      commit: commit.id,
      branch: commit.branch,
      batch,
      // FIXME: we shouldn't update the date if it already exists.
      date: new Date().toLocaleString(),
    }

    const key = milestone_key(project, commit, batch)
    if (is_shared)
      this.updateShared({key, milestone});
    else {
      const local_milestones = project_data.milestones || {};
      local_milestones[key] = milestone;
      dispatch(updateMilestones(project, local_milestones));
      toaster.show({
        message: "Saved",
        intent: Intent.SUCCESS,
        timeout: 5000
      });
    }
  }

  saveMilestoneMaybeAskForConfirmation = () => {
    const { commit, project, project_data, selected, label } = this.props;
    const batch = selected[`selected_batch_${label}`];
    const key = milestone_key(project, commit, batch)
    const shared_milestones = ((project_data || {}).data || {}).milestones || {}
    if (key in shared_milestones)
      this.setState({ show_alert_overwrite: true, overwrite_shared_label: shared_milestones[key].label });
    else
      this.saveMilestone();
  }

  deleteMilestone = () => {
    const { dispatch, commit, project, project_data, selected, label } = this.props;
    let batch = selected[`selected_batch_${label}`];
    const key = milestone_key(project, commit, batch)
    switch (this.getMilestoneType()) {
      case "local":
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


export { MilestonesMenu, CommitMilestoneEditor };
