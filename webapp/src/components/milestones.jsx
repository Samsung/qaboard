import { useState } from "react";
import { DateTime } from 'luxon';
import { useQueryClient } from "@tanstack/react-query";

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
} from "@blueprintjs/core";

import { http } from "../api/http";
import { usePrefsStore } from "../stores/prefs";
import { match_query } from "../utils";
import { toaster } from "../toaster"


const milestone_key = (project, commit, batch) => `${project}/${commit?.id}/${batch?.label ?? 'default'}`
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

const getPersonFilter = (milestone) => {
  // Filter by owner names (both full_name and user_name)
  let personFilter = ''
  if (milestone.owners) {
    const ownerNames = milestone.owners
      .map(o => `${o.full_name || ''} ${o.user_name || ''}`)
      .join(' ')
    personFilter = ownerNames
  }

  // Filter by committer name too
  if (milestone.committer_name) {
    personFilter = `${personFilter} ${milestone.committer_name}`
  }

  return personFilter
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
          .filter(m => matcher(`${m.project} ${m.commit} ${m.batch} ${m.filter} ${m.label} ${m.notes} ${getPersonFilter(m)}`))
          .sort( (m0, m1) => sortWeight * (new Date(m0.date) - new Date(m1.date)))
         || [])
         .map(  (m, idx) => <MilestoneMenu project={project} icon={icon} key={`${type}-${idx}`} milestone={m} onSelect={onSelect} /> )
      : <></>
    return <>
      {(!!title && has_milestones) && <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>{title}</h6></li>}
      {Object.keys(milestones).length > 1 &&
          <ControlGroup>
            <InputGroup
              placeholder="filter milestones by label, branch, owner..."
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
      {!!milestone.committer_name && <Tag minimal icon="person" style={{marginRight: '5px'}}>{milestone.committer_name}</Tag>}
      {has_notes && <Tooltip position="right" content={<pre>{notes}</pre>}>
        <Tag icon="more" style={{marginRight: '5px'}}/>
      </Tooltip>}
    </>}
    onClick={() => !!onSelect && onSelect(milestone)}
  />
}





const CommitMilestoneEditor = ({ project, project_shown, project_data, commit, batch, filter }) => {
  const queryClient = useQueryClient();
  const setPrivateMilestone = usePrefsStore(state => state.setMilestone);
  const deletePrivateMilestone = usePrefsStore(state => state.deleteMilestone);
  const [is_shared, setIsShared] = useState(false);
  // the milestone being edited, if it exists
  const [previous_milestone, setPreviousMilestone] = useState({});
  const [overwrite_milestone, setOverwriteMilestone] = useState({});
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  // we ask for confirmation when users delete/overwrite a milestone
  const [show_alert_remove, setShowAlertRemove] = useState(false);
  const [show_alert_overwrite, setShowAlertOverwrite] = useState(false);

  const type = milestone_type({ commit, project_shown, project_data, batch });
  const key = milestone_key(project_shown, commit, batch)
  const shared_milestones = project_data?.data?.milestones ?? {}
  const private_milestones = project_data?.milestones ?? {}
  const icon = type === 'none' ? 'star-empty' : (type === 'shared' ? 'crown' : 'star');
  const color = type === 'none' ? undefined : Colors.GOLD4;

  // When the editor opens, we show the milestone's current data
  const updateData = () => {
    if (type === 'none') {
      setPreviousMilestone({})
      setLabel('')
      setNotes('')
      setIsShared(true)
    } else {
      const matching_milestone = (type === 'private' ? private_milestones : shared_milestones)[key]
      setPreviousMilestone({...matching_milestone})
      setLabel(matching_milestone.label ?? '')
      setNotes(matching_milestone.notes ?? '')
      setIsShared(type === 'shared')
    }
  }

  const updateShared = async ({key, milestone, should_delete}) => {
    const data = {
      project,
      key,
      milestone,
      "delete": should_delete ? 'true' : 'false',
    };
    try {
      await http.post("/api/v1/project/milestones/", data)
      toaster.show({
        message: should_delete ? 'Deleted' : 'Saved.',
        intent: Intent.SUCCESS,
        timeout: 4500,
      });
      // The projects' data has the shared milestones
      queryClient.invalidateQueries({queryKey: ['projects']})
      queryClient.invalidateQueries({queryKey: ['project']})
    } catch (error) {
      // Handle auth errors with user-friendly messages
      const error_message = error.response?.data?.error;
      if (error.response?.status === 401) {
        toaster.show({ message: error_message || 'Please log in to manage milestones', intent: Intent.DANGER, timeout: 5000 });
      } else if (error.response?.status === 403) {
        toaster.show({ message: error_message || 'You can only edit or delete your own milestones', intent: Intent.DANGER, timeout: 5000 });
      } else {
        toaster.show({ message: error_message || `${error}`, intent: Intent.DANGER, timeout: 3000 });
      }
      throw error
    }
  }

  const deleteMilestone = () => {
    setShowAlertRemove(false)
    setShowAlertOverwrite(false)
    if (type === 'private') {
      deletePrivateMilestone(project, key)
      toaster.show({
        message: "Deleted.",
        intent: Intent.SUCCESS,
        timeout: 4000
      });
    } else if (type === 'shared') {
      updateShared({key, should_delete: true}).catch(() => {});
    }
  }

  const saveMilestone = async () => {
    setShowAlertOverwrite(false)
    const milestone = {
      label,
      notes,
      commit: commit.id,
      branch: commit.branch,
      batch: batch.label,
      filter,
      date: (type !== 'none' && previous_milestone.date) || new Date(),
      committer_name: commit.committer_name,
      ...(project !== project_shown ? {project: project_shown} : {}),
    }
    if (is_shared) {
      // Saving a shared milestone overwrites the one with the same key
      try {
        await updateShared({key, milestone});
      } catch {
        return
      }
      if (type === 'private')
        deletePrivateMilestone(project, key)
    } else {
      if (type === 'shared')
        updateShared({key, should_delete: true}).catch(() => {});
      setPrivateMilestone(project, key, milestone)
      toaster.show({
        message: "Saved",
        intent: Intent.SUCCESS,
        timeout: 5000
      });
    }
  }

  const saveMilestoneMaybeAskForConfirmation = () => {
    if (key in shared_milestones) {
      setShowAlertOverwrite(true)
      setOverwriteMilestone(shared_milestones[key])
    } else {
      saveMilestone();
    }
  }

  const popover_body = <div>
    <H5>Milestone Info</H5>
    <Switch
      label='Shared'
      checked={is_shared}
      style={{ width: "200px" }}
      onChange={() => setIsShared(!is_shared)}
    />
    <FormGroup inline label="Label" labelInfo="(optional)" labelFor="milestone-label-input">
      <InputGroup
        id="milestone-label-input"
        value={label}
        style={{ width: "200px" }}
        onChange={e => setLabel(e.target.value)}
      />
    </FormGroup>
    <FormGroup inline label="Notes" labelFor="milestone-notes-input" labelInfo="(optional)">
      <TextArea id="milestone-notes-input" onChange={e => setNotes(e.target.value)} value={notes} style={{ width: "200px" }} />
    </FormGroup>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 30 }}>
      {(type !== 'none') && <>
        <Button
          text="Delete"
          onClick={() => setShowAlertRemove(true)}
          intent={Intent.DANGER}
          style={{ marginRight: 50 }}
        />
        <Alert
          className={Classes.POPOVER_DISMISS}
          canEscapeKeyCancel
          cancelButtonText="Cancel"
          confirmButtonText="Delete"
          icon="trash"
          intent={Intent.DANGER}
          isOpen={show_alert_remove}
          onCancel={() => setShowAlertRemove(false)}
          onConfirm={deleteMilestone}
          style={{width: '1200px', maxWidth: "fit-content"}}
        >
          <div>Are you sure you want to delete this milestone?
            <Menu>
              <MilestoneMenu milestone={previous_milestone}/>
            </Menu>
          </div>
        </Alert>
      </>}
      <Button className={Classes.POPOVER_DISMISS} text="Save" intent={Intent.PRIMARY} onClick={saveMilestoneMaybeAskForConfirmation} />
    </div>
  </div>

  return <>
    <Popover
      content={popover_body}
      placement="right"
      popoverClassName={Classes.POPOVER_CONTENT_SIZING}
    >
      <Tooltip content={type !== 'none' ? "Edit Milestone" : "Save as Milestone"} position={Position.BOTTOM} >
        <Button minimal style={{ marginRight: '5px' }} onClick={updateData} aria-label={type !== 'none' ? "Edit Milestone" : "Save as Milestone"}>
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
      onCancel={() => setShowAlertOverwrite(false)}
      onConfirm={saveMilestone}
    >
      <div>A similar shared milestone already exist: <Menu><MilestoneMenu icon="crown" milestone={overwrite_milestone}/></Menu>.</div>
      <p>Would you like to overwrite it?</p>
    </Alert>
  </>
}


export { MilestonesMenu, CommitMilestoneEditor, has_milestones };
