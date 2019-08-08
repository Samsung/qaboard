import React from "react";
import { post } from "axios";
import {
  Classes,
  Tag,
  Button,
  Intent,
  EditableText,
  TextArea,
  Tooltip,
  Popover,
  FormGroup,
  InputGroup,
  Menu,
  Icon,
  Colors,
  Position,
  H5,
  Alert,
  Toaster,
} from "@blueprintjs/core";

import { CommitAvatar } from "./avatars";
import { DoneAtTag } from "./DoneAtTag";

import { fetchCommit } from "../actions/commit";
import { updateSelected } from "../actions/selected";
import { updateMilestones } from "../actions/projects";
import { shortId } from "../utils";

const toaster = Toaster.create();


class CommitMessage extends React.PureComponent {
  render() {
    const { commit } = this.props;
    const style = { marginTop: "10px", whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', ...this.props.style }
    if (commit === undefined || commit === null || commit.message === undefined || commit.message === null || commit.message === '') {
      return <span className={`${Classes.SKELETON} ${Classes.MONOSPACE_TEXT}`} style={style}>This is a placeholder for the commit message. Yep.</span>
    }
    return <>
      <span style={style} title={commit.message} className={Classes.MONOSPACE_TEXT} >
        {commit.message}
      </span>
    </>
  }
}

class CommitBranchButton extends React.PureComponent {
  render() {
    const { commit, onClick, style } = this.props;
    const has_branch = !!commit && !!commit.branch
    return <span style={style}>
      <Button minimal onClick={e => { onClick(commit.branch) }} className={has_branch ? null : Classes.SKELETON} icon="git-branch" >
        {has_branch ? commit.branch.replace('origin/', '') : 'master'}
      </Button>
    </span>
  }
}


class CommitNavbar extends React.Component {
  render() {
    const { project, project_data, commit, selected, label, dispatch } = this.props;
    const qatools_config = (((project_data || {}).data || {}).qatools_config)
    const qatools_milestones = (((qatools_config || {}).project || {}).milestones || [])
    const reference_branch = (((qatools_config || {}).project || {}).reference_branch) || 'master';

    return (
      <FormGroup style={{ marginTop: '45px' }}>
        <div style={{ 'marginRight': '10px', display: 'block', position: 'relative', width: '600px', marginBottom: '6px' }}>
          <span style={{ display: 'flex' }}>
            <Tag style={{ flex: '0 1 auto', alignSelf: 'center', marginRight: '5px', fontFamily: 'monospace' }} minimal>{label}</Tag>
            <CommitAvatar size='20px' commit={commit} style={{ marginRight: '5px' }} />
            <CommitMessage
              project={project}
              commit={commit}
              style={{ maxWidth: "450px", minWidth: "450px", flex: '0 1 auto', alignSelf: 'center' }}
              is_loaded={!!commit && commit.id && !this.props.commit.is_loaded}
            />
          </span>
        </div>
        <div style={{ display: 'flex' }}>

          <CommitMilestone commit={commit} project={project} project_data={project_data} selected={selected} dispatch={dispatch} label={label} />

          <Popover position="auto" hoverCloseDelay={500} interactionKind={"hover"}>
            <span style={{ flex: '0 1 auto', alignSelf: 'center' }}>
              <EditableText
                onConfirm={this.handleSubmit}
                minWidth={60}
                placeholder='id'
                key={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
                defaultValue={(!!commit && !!commit.id) ? shortId(project, commit.id) : ''}
              /></span>
            <Menu>
              <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Compare to the reference branch</h6></li>
              <Menu.Item text={reference_branch} icon="git-branch" onClick={() => this.handleSubmitBranch(reference_branch)} />

              <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Compare to milestones</h6></li>
              {qatools_milestones.map((m, idx) => <MilestoneMenu key={`qatools-${idx}`} milestone={m} selectMilestone={this.handleSubmitBranch} />)}
              {qatools_milestones.length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qatools.yaml</em> configuration.</span>}
              {(project_data.data.milestones || []).map((m, idx) => <MilestoneMenu key={`shared-${idx}`} milestone={m} selectMilestone={this.handleSubmitBatch} />)}

              {project_data.milestones && <>
                <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Compare to local milestones</h6></li>
                {project_data.milestones.map((m, idx) => <MilestoneMenu key={`local-${idx}`} milestone={m} selectMilestone={this.handleSubmitBatch} />)}
              </>}

              <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>Actions</h6></li>
              <Menu.Item text="Remove reference" icon="delete" onClick={() => this.handleSubmitBranch(null)} />
            </Menu>
          </Popover>
          <CommitBranchButton commit={commit} onClick={this.handleSubmitBranch} style={{ flex: '0 1 auto', alignSelf: 'center' }} />

          <DoneAtTag dispatch={this.props.dispatch} project={project} commit={commit} style={{ flex: '0 1 auto', alignSelf: 'center' }} />{" "}
          {!!commit && !!commit.error && <Tooltip><Tag intent={Intent.DANGER} icon="error" style={{ marginRight: '8px' }}>Error</Tag><span>{commit.error}</span></Tooltip>}
        </div>
      </FormGroup>
    );
  }


  handleSubmit = id => {
    const { project, label, selected, dispatch } = this.props;
    const attribute = `${label}_commit_id`
    const commit_id = selected[attribute]
    if (commit_id === undefined || commit_id === null || !commit_id.startsWith(id)) {
      dispatch(fetchCommit(project, id, attribute));
      dispatch(updateSelected(project, { [attribute]: id }))
    }
  };

  handleSubmitBranch = branch => {
    const { project, dispatch } = this.props;
    console.log(project);
    console.log(branch);

    dispatch(fetchCommit(project, null, "ref_commit_id", branch));
    dispatch(updateSelected(project, { ref_commit_id: branch }))
  };


  handleSubmitBatch = milestone => {
    console.log(this.props.selected)
    const { project, dispatch } = this.props;
    dispatch(fetchCommit(project, milestone.commit, "ref_commit_id", null));
    dispatch(updateSelected(project, { ref_commit_id: milestone.commit, selected_batch_ref: milestone.batch }))
  };

}

const MilestoneMenu = ({ milestone, selectMilestone }) => {
  //console.log(milestone);
  return <Menu.Item
    text={milestone.label || milestone.commit || milestone}
    icon="star"
    onClick={() => selectMilestone(milestone)}
  />
}
///////////////////////////// CommitMilestone //////////////////////////////////

class CommitMilestone extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      type: 'none', // local | shared | none
      label: '',
      notes: '',
      // we ask for confirmation when users delete a milestone
      alert_is_open: false,
    };
  }


  render() {
    const { type, label, notes, alert_is_open } = this.state;
    const is_milestone = this.isMilestone();
    const icon = is_milestone ? (type === 'shared' ? 'crown' : 'star') : 'star-empty';
    const color = is_milestone ? Colors.GOLD4 : undefined;

    const popover_body = < div >
      <H5>Edit Milestone</H5>
      <FormGroup inline label="Label" labelFor="text-input">
        <InputGroup
          id="text-input"
          value={label}
          autoFocus
          style={{ width: "200px" }}
          onChange={this.update('label')}
          onFocus={(event) => event.target.select()}
        />
      </FormGroup>
      <FormGroup
        inline
        label="Notes"
        labelFor="text-input"
      >
        <TextArea onChange={this.update('notes')} value={notes} style={{ width: "200px" }} />
      </FormGroup>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 30 }}>
        {is_milestone && <>
          <Button
            text="Remove"
            onClick={this.handleRemoveOpen}
            intent={Intent.DANGER}
            style={{ marginRight: 50 }}
          />
          <Alert
            Button className={Classes.POPOVER_DISMISS}
            canEscapeKeyCancel
            cancelButtonText="Cancel"
            confirmButtonText="Remove"
            icon="trash"
            intent={Intent.DANGER}
            isOpen={alert_is_open}
            onCancel={this.handleRemoveCancel}
            onConfirm={this.handleRemoveConfirm}
          >
            <p>Are you sure you want to remove <b>{label}</b>?</p>
          </Alert>
        </>}
        <Button className={Classes.POPOVER_DISMISS} text={"Cancel"} style={{ marginRight: 10 }} />
        <Button className={Classes.POPOVER_DISMISS} text={"Done"} intent={Intent.PRIMARY} onClick={this.handleConfirm} />
      </div>
    </div >

    return <>
      <Popover
        content={popover_body}
        position={Position.RIGHT}
        popoverClassName={Classes.POPOVER_CONTENT_SIZING} >
        <Tooltip content={`${is_milestone ? "Edit" : "Create"} batch milestone`} position={Position.BOTTOM} intent={Intent.PRIMARY}>
          <Button minimal style={{ marginRight: '5px' }} onClick={this.handleClick}>
            <Icon icon={icon} color={color} />
          </Button>
        </Tooltip>
      </Popover >
    </>
  }

  isMilestone = () => {
    const { commit, project_data, selected, label } = this.props;

    if (commit && project_data.milestones) {
      let batch = selected[`selected_batch_${label}`];
      return !!project_data.milestones.find(m => m && (m.commit === commit.id) && (m.batch === undefined || m.batch === batch));
    }

    return false;


  }

  updateData = () => {
    const { commit, project_data, selected, label } = this.props;
    let batch = selected[`selected_batch_${label}`];
    let matching_milestone = project_data.milestones.find(m => m && (m.commit === commit.id) && (m.batch === batch));
    if (!!matching_milestone) { // this evaluation probably can be removed.
      this.setState({
        type: 'local',
        label: matching_milestone.label,
        notes: matching_milestone.notes,
      })
    }
  }



  handleClick = () => {

    if (this.isMilestone()) {
      // load info from local or shared
      this.updateData();
    }
    else {
      // Add a default label
      const { commit, project, selected, label } = this.props;
      this.setState({ label: !!commit && (shortId(project, commit.id) + "/" + selected[`selected_batch_${label}`]), notes: '' })
    }
  }

  handleConfirm = () => {
    const { dispatch, commit, project, project_data, selected, label } = this.props;
    const milestones = project_data.milestones || []

    if (this.isMilestone()) {
      // remove milestone from project_data
      let batch = selected[`selected_batch_${label}`];
      let idx = milestones.findIndex(m => m && (m.commit === commit.id) && (m.batch === undefined || m.batch === batch));
      milestones.splice(idx, 1);
    }

    milestones.push({
      label: this.state.label,
      notes: this.state.notes,
      commit: selected[`${label}_commit_id`],
      batch: selected[`selected_batch_${label}`],
      date: new Date().toLocaleString(),
    })
    // edit the milestones ....
    // read all the milestones from [local, shared]
    // if one matches (project, commit, batch), then read (label, notes) from there
    // when editing, change that one, leave the rest untouched

    // // local:
    // let batch =  selected[`selected_batch_${label}`]
    // matching_milestone = project_data.milestone.find(m => (m.project === undefined || m.project === project) && (m.commit===commit.id) &&  (m.batch === undefined || m.batch === batch ))[0]
    // if (!!matching_milestone) // win: read
    // return .... .... 

    dispatch(updateMilestones(project, milestones))
    this.setState(state => ({
      type: 'local',
    }));
    toaster.show({
      message: <div><b>{this.state.label}</b> was saved!</div>,
      intent: Intent.SUCCESS,
      timeout: 3000
    });
  }

  handleRemoveOpen = () => this.setState({ alert_is_open: true });

  handleRemoveCancel = () => this.setState({ alert_is_open: false });

  handleRemoveConfirm = () => {
    if (this.isMilestone()) {

      const { dispatch, commit, project, project_data, selected, label } = this.props;
      const milestones = project_data.milestones || []
      let batch = selected[`selected_batch_${label}`];
      let idx = milestones.findIndex(m => m && (m.commit === commit.id) && (m.batch === undefined || m.batch === batch));
      milestones.splice(idx, 1);

      dispatch(updateMilestones(project, milestones))
      toaster.show({
        message: <div><b>{this.state.label}</b> was removed</div>,
        intent: Intent.NONE,
        timeout: 3000
      });

      this.setState({
        type: 'none',
        label: '',
        notes: '',
        alert_is_open: false,
      });
    }
  }


  update = name => event => {
    this.setState({ [name]: event.target.value });
  }


  //////////////////////////////// shared ////////////////////////////////////////
  loadFromDB = () => {
    const data = {
      id: this.props.commit.id,
    };

    post("http://planet31:9002/api/v1/project/milestones/load", data) // for DEBUG
      .then(res => {
        //console.log(res.data);
        //console.debug(regions_of_interest)

      })
  }

  // also should overwrite if exist.
  saveToDB = () => {
    const data = {
      project: this.props.project,
      label: this.state.label,
      notes: this.state.notes,
      id: this.props.commit.id,
    };

    post("http://planet31:9002/api/v1/project/milestones/save", data) // for DEBUG
      .then(res => {
        //console.log(res.data);
        //console.debug(regions_of_interest)

      })
  }

  deleteFromDB = () => {
    const data = {
      id: this.props.commit.id,
    };

    post("http://planet31:9002/api/v1/project/milestones/delete", data) // for DEBUG
      .then(res => {
        //console.log(res.data);
        //console.debug(regions_of_interest)
      })
  }

}


export { CommitNavbar };
