import React from "react";
import { get, post } from "axios";
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
  Switch,
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

          <Popover position="bottom" hoverCloseDelay={500} interactionKind={"hover"}>
            <span style={{ flex: '0 1 auto', alignSelf: 'center' }}>
              <EditableText
                style={{ marginTop: '4px' }}
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
              {qatools_milestones.map((m, idx) => <MilestoneMenu icon="crown" key={`qatools-${idx}`} milestone={m} selectMilestone={this.handleSubmitBranch} />)}
              {qatools_milestones.length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qatools.yaml</em> configuration.</span>}
              {(project_data.data.milestones || []).map((m, idx) => <MilestoneMenu icon="crown" key={`shared-${idx}`} milestone={m} selectMilestone={this.handleSubmitBatch} />)}

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

    dispatch(fetchCommit(project, null, "ref_commit_id", branch));
    dispatch(updateSelected(project, { ref_commit_id: branch }))
  };


  handleSubmitBatch = milestone => {
    const { project, dispatch } = this.props;
    dispatch(fetchCommit(project, milestone.commit, "ref_commit_id", null)); // which branch?
    dispatch(updateSelected(project, { ref_commit_id: milestone.commit, selected_batch_ref: milestone.batch }))
  };

}

const MilestoneMenu = ({ milestone, selectMilestone, icon }) => {
  return <Menu.Item
    text={milestone.label || milestone.commit || milestone}
    icon={icon || "star"}
    onClick={() => selectMilestone(milestone)}
  />
}
///////////////////////////// CommitMilestone //////////////////////////////////

class CommitMilestone extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      current_label: '',
      previous_label: '',
      notes: '',
      shared_button_is_on: false,
      // we ask for confirmation when users delete a milestone
      alert_is_open: false,

      db_milestones: {},
    };
  }

  componentDidMount() {
    this.getFromDB();
  }

  render() {
    const { current_label, previous_label, notes, alert_is_open, shared_button_is_on } = this.state;
    const milestone_type = this.MilestoneType();
    const icon = milestone_type === 'none' ? 'star-empty' : (milestone_type === 'shared' ? 'crown' : 'star');
    const color = milestone_type === 'none' ? undefined : Colors.GOLD4;

    const popover_body = < div >
      <H5>Edit Milestone</H5>
      <Switch
        label='Shared'
        checked={shared_button_is_on}
        autoFocus
        style={{ width: "200px" }}
        onChange={this.toggleSharedButton}
      />
      <FormGroup inline label="Label" labelFor="text-input">
        <InputGroup
          id="text-input"
          value={current_label}
          autoFocus
          style={{ width: "200px" }}
          onChange={this.update('current_label')}
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
        {(milestone_type !== 'none') && <>
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
            <p>Are you sure you want to remove <b>{previous_label}</b>?</p>
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
        <Tooltip content={`${milestone_type !== 'none' ? "Edit" : "Create"} batch milestone`} position={Position.BOTTOM} intent={Intent.PRIMARY}>
          <Button minimal style={{ marginRight: '5px' }} onClick={this.handleClick}>
            <Icon icon={icon} color={color} />
          </Button>
        </Tooltip>
      </Popover >
    </>
  }

  toggleSharedButton = () => {
    this.setState(state => ({ shared_button_is_on: !state.shared_button_is_on }))
  }

  MilestoneType = () => {
    const { commit, project_data, selected, label } = this.props;

    if (commit) {
      let batch = selected[`selected_batch_${label}`];

      // check local
      if (project_data.milestones) {
        let is_local = !!project_data.milestones.find(m => m && (m.commit === commit.id) && (m.batch === undefined || m.batch === batch));
        if (is_local) return 'local';
      }

      // check shared
      let key = `${commit.id}/${batch}`; // CONVENTION
      let is_shared = key in this.state.db_milestones;
      if (is_shared) return 'shared';

      // TODO: search in qa yaml?

    }

    return 'none'; // not a milestone
  }

  updateData = (type) => { // check local and shared

    const { commit, project, project_data, selected, label } = this.props;
    let batch = selected[`selected_batch_${label}`];
    let matching_milestone = {}

    switch (type) {
      case 'none':
        this.setState({
          current_label: !!commit && (shortId(project, commit.id) + "/" + selected[`selected_batch_${label}`]),
          notes: '',
          shared_button_is_on: true,
        })
        break;

      case 'local':
        matching_milestone = project_data.milestones.find(m => m && (m.commit === commit.id) && (m.batch === batch));
        if (!!matching_milestone) { // this evaluation probably can be removed.
          this.setState({
            current_label: matching_milestone.label,
            previous_label: matching_milestone.label,
            notes: matching_milestone.notes,
            shared_button_is_on: false,
          })
        }
        break;

      case 'shared':
        let key = `${commit.id}/${batch}`; // CONVENTION
        matching_milestone = this.state.db_milestones[key];
        if (!!matching_milestone) {
          this.setState({
            current_label: matching_milestone.label,
            previous_label: matching_milestone.label,
            notes: matching_milestone.notes,
            shared_button_is_on: true,
          })
        }
        break;

      default:
        break;
    }


  }

  handleClick = () => {
    let milestone_type = this.MilestoneType();

    // load info from local or shared or default label
    this.updateData(milestone_type);
  }

  handleConfirm = () => {

    const { commit, dispatch, project, project_data, selected, label } = this.props;
    const { shared_button_is_on } = this.state
    const batch = selected[`selected_batch_${label}`];

    // first remove if already exists
    this.handleRemoveConfirm();

    const new_milestone = {
      label: this.state.current_label,
      notes: this.state.notes,
      commit: commit.id,
      batch: batch,
      date: new Date().toLocaleString(),
    }

    if (shared_button_is_on) { // save to share storage
      this.saveToDB(new_milestone);
    }
    else { // save to local storage
      const milestones = project_data.milestones || [];
      milestones.push(new_milestone);
      dispatch(updateMilestones(project, milestones));

    }

    toaster.show({
      message: <div><b>{this.state.current_label}</b> was saved!</div>,
      intent: Intent.SUCCESS,
      timeout: 4500
    });
  }


  handleRemoveConfirm = () => {
    const { dispatch, commit, project, project_data, selected, label } = this.props;
    let milestone_type = this.MilestoneType();
    let batch = selected[`selected_batch_${label}`];

    switch (milestone_type) {
      case "local":
        const milestones = project_data.milestones || []
        let idx = milestones.findIndex(m => m && (m.commit === commit.id) && (m.batch === undefined || m.batch === batch));
        milestones.splice(idx, 1);

        dispatch(updateMilestones(project, milestones))

        break;

      case "shared":
        this.removeFromDB(commit, batch);
        break;

      default: // case 'none'
        return;
    }

    toaster.show({
      message: <div><b>{this.state.previous_label}</b> was removed</div>,
      intent: Intent.PRIMARY,
      timeout: 4000
    });

    this.setState({
      current_label: '',
      previous_label: '',
      notes: '',
      alert_is_open: false,
    });
  }


  handleRemoveOpen = () => this.setState({ alert_is_open: true });

  handleRemoveCancel = () => this.setState({ alert_is_open: false });

  update = name => event => { this.setState({ [name]: event.target.value }) }


  ////////////////////////////// shared ////////////////////////////////////////

  getFromDB = () => {
    get("http://planet31:9002/api/v1/project/milestones/get",
      { params: { project: this.props.project } }) // for DEBUG
      .then(res => {
        if (res.data !== "FAILED") {
          this.setState({ db_milestones: res.data });
        }
      })
  }


  saveToDB = (milestone) => {
    const data = {
      project: this.props.project,
      ...milestone,
    };
    post("http://planet31:9002/api/v1/project/milestones/save", data) // for DEBUG
      .then(res => {
        this.setState({ db_milestones: res.data });
      })
  }


  removeFromDB = (commit, batch) => {
    const data = {
      project: this.props.project,
      commit: commit.id,
      batch: batch,
    };
    post("http://planet31:9002/api/v1/project/milestones/remove", data) // for DEBUG
      .then(res => {
        this.setState({ db_milestones: res.data });
      })
  }

  /*
  loadFromDB = (commit, batch) => {
    const data = {
      project: this.props.project,
      commit: commit.id,
      batch: batch,
    };
    post("http://planet31:9002/api/v1/project/milestones/load", data) // for DEBUG
    .then(res => {
      
      })
    }

    isInDB = (commit, batch) => {
      const data = {
        commit: commit.id,
        batch: batch,
      };
      post("http://planet31:9002/api/v1/project/milestones/is_exist", data) // for DEBUG
        .then(res => {
    
        })
    }
    */
}


export { CommitNavbar };
