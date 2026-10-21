// Admin → Overview: roles on all projects (design/user-management.md, Appendix D.2). The defaults are settings:
// the role signed-in users get on public and internal projects, and the projects' default visibility.
// Grants on all projects are for users and groups that need every project, private ones included.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Callout, Classes, FormGroup, HTMLSelect, HTMLTable, Intent } from "@blueprintjs/core";
import styled from "styled-components";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { Time } from "../settings/format";
import { Loading } from "../settings/states";
import { SubjectPicker } from "../access/SubjectPicker";
import { RoleTag, SubjectName, subjectText, role_options, roleLabel, visibilities } from "../access/roles";
import { SettingValue, SourceTag } from "./Settings";
import { AdminError } from "./states";
import { instanceGrantsQuery, addInstanceGrant, deleteInstanceGrant, settingsQuery, saveSetting } from "./api";


const showSuccess = message => toaster.show({ message, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });

// The settings shown here, with what they mean
const access_settings = [
  {
    key: 'projects.signed_in_role',
    label: 'Role of signed-in users',
    labels: { viewer: 'Viewer', developer: 'Developer' },
    note: "Signed-in users on public and internal projects. Developer: anyone signed in can upload and act on runs, as before roles. Set Viewer once projects have owners.",
  },
  {
    key: 'projects.default_visibility',
    label: 'Default visibility',
    labels: Object.fromEntries(visibilities.map(v => [v.id, v.label])),
    note: "Projects that don't set their own, nor their folder. Public: anyone who can open QA-Board. Internal: anyone signed in. Private: only members.",
  },
];

const SettingsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px 24px;
  margin-bottom: 16px;
  max-width: 920px;
`;

const AccessSetting = ({ setting, label, labels, note }) => {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const can_edit = setting.editable !== false && setting.source !== 'env';
  const id = `setting-${setting.key.replace(/\W/g, '-')}`;
  const choices = setting.choices?.length ? setting.choices : Object.keys(labels);
  const save = value => {
    setSaving(true);
    saveSetting(queryClient, setting.key, value)
      .then(() => showSuccess(`Saved ${setting.key}`))
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setSaving(false));
  };
  return <FormGroup
    label={label}
    labelFor={id}
    // only the environment's settings say so: they can't be changed here
    labelInfo={setting.source === 'env' ? <SourceTag setting={setting}/> : undefined}
    helperText={note}
    style={{ margin: 0 }}
  >
    {can_edit
      ? <HTMLSelect id={id} value={setting.value ?? ''} disabled={saving} onChange={e => save(e.target.value)} options={choices.map(choice => ({ value: choice, label: labels[choice] ?? choice }))}/>
      : <SettingValue value={setting.value}/>}
  </FormGroup>;
};


export const InstanceRoles = () => {
  const queryClient = useQueryClient();
  const { data: grants, isPending, error, refetch } = useQuery(instanceGrantsQuery);
  const { data: settings = [] } = useQuery(settingsQuery);
  const [subject, setSubject] = useState(null);
  const [role, setRole] = useState('viewer');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form_error, setFormError] = useState(null);

  const add = event => {
    event.preventDefault();
    if (!subject) return;
    setAdding(true);
    setFormError(null);
    addInstanceGrant(queryClient, { subject, role })
      .then(() => {
        showSuccess(`${subjectText(subject)} is ${roleLabel(role).toLowerCase()} on all projects`);
        setSubject(null);
      })
      .catch(error => setFormError(errorMessage(error)))
      .finally(() => setAdding(false));
  };
  const remove = grant => {
    setBusy(true);
    deleteInstanceGrant(queryClient, grant.id)
      .then(() => showSuccess(`Removed the role of ${subjectText(grant.subject)} on all projects`))
      .catch(error => setFormError(errorMessage(error)))
      .finally(() => {
        setBusy(false);
        setRemoving(null);
      });
  };
  const shown_settings = access_settings
    .map(item => ({ ...item, setting: settings.find(setting => setting.key === item.key) }))
    .filter(item => item.setting);

  return <section aria-label="Roles on all projects" style={{ marginBottom: 28 }}>
    <h4 className={Classes.HEADING}>Roles on all projects</h4>
    {shown_settings.length > 0 && <SettingsGrid>
      {shown_settings.map(item => <AccessSetting key={item.key} {...item}/>)}
    </SettingsGrid>}
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 720 }}>
      Users and groups with a role on every project, private ones included, e.g. a QA team as viewers.
      Project owners give the other roles, on each project's Access page.
    </p>
    {isPending && <Loading label="Loading the roles on all projects"/>}
    {error && <AdminError error={error} refetch={refetch} what="the roles on all projects"/>}
    {!isPending && !error && grants.length > 0 && <div style={{ overflowX: 'auto', marginBottom: 12 }}>
      <HTMLTable compact style={{ width: '100%' }} aria-label="Roles on all projects">
        <thead><tr><th>Member</th><th>Role</th><th>Added</th><th><span className={Classes.TEXT_MUTED} style={{ fontWeight: 'normal' }}>Actions</span></th></tr></thead>
        <tbody>
          {grants.map(grant => <tr key={grant.id} data-testid={`instance-grant-${grant.id}`}>
            <td><SubjectName subject={grant.subject}/></td>
            <td><RoleTag role={grant.role}/></td>
            <td><Time iso={grant.granted_at} never="—"/></td>
            <td><Button variant="minimal" icon="trash" intent={Intent.DANGER} aria-label={`Remove ${subjectText(grant.subject)}`} onClick={() => setRemoving(grant)}/></td>
          </tr>)}
        </tbody>
      </HTMLTable>
    </div>}
    <form onSubmit={add} aria-label="Give a role on all projects" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
      <FormGroup label="User or group" labelFor="instance-grant-subject" style={{ margin: 0, flex: '1 1 240px', maxWidth: 400 }}>
        <SubjectPicker id="instance-grant-subject" value={subject} onChange={setSubject}/>
      </FormGroup>
      <FormGroup label="Role" labelFor="instance-grant-role" style={{ margin: 0 }}>
        <HTMLSelect id="instance-grant-role" value={role} onChange={e => setRole(e.target.value)} options={role_options}/>
      </FormGroup>
      <Button type="submit" icon="add" text="Give the role" loading={adding} disabled={!subject}/>
    </form>
    {form_error && <Callout intent={Intent.DANGER} role="alert" compact style={{ marginTop: 12, maxWidth: 720 }}>{form_error}</Callout>}
    <Alert
      isOpen={!!removing}
      intent={Intent.DANGER}
      icon="trash"
      cancelButtonText="Cancel"
      confirmButtonText="Remove"
      loading={busy}
      onCancel={() => setRemoving(null)}
      onConfirm={() => remove(removing)}
      canEscapeKeyCancel
    >
      {removing && <p>
        Remove the {roleLabel(removing.role).toLowerCase()} role of <strong>{subjectText(removing.subject)}</strong> on all projects?
        They keep the roles given on each project, and what the projects' visibility gives.
      </p>}
    </Alert>
  </section>;
};

export default InstanceRoles;
