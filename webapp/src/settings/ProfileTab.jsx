// Settings → Profile: who QA-Board thinks you are
import { Classes, HTMLTable, Tag } from "@blueprintjs/core";

import { Avatar } from "../components/avatars";
import { useSiteConfig } from "../hooks";
import { AdminTag, loginTypeLabel } from "./format";


export const ProfileTab = ({ user }) => {
  const { avatar_url_template } = useSiteConfig();
  const display_name = user.full_name || user.user_name;
  const avatar_url = avatar_url_template ? avatar_url_template.replace('{user_name}', user.user_name) : null;
  const login_type = (user.login_type ?? '').toUpperCase();
  return <section aria-label="Profile">
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
      <Avatar src={avatar_url} name={display_name} size="64px"/>
      <div>
        <h3 className={Classes.HEADING} style={{ margin: 0 }}>{display_name}</h3>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {user.is_admin && <AdminTag/>}
          {user.kind === 'service' && <Tag minimal icon="automatic-updates">Service account</Tag>}
        </div>
      </div>
    </div>
    <HTMLTable compact style={{ maxWidth: '100%' }}>
      <tbody>
        <tr><th scope="row">Name</th><td>{user.full_name || <span className={Classes.TEXT_MUTED}>Not set</span>}</td></tr>
        <tr><th scope="row">User name</th><td><code>{user.user_name}</code></td></tr>
        <tr><th scope="row">Email</th><td>{user.email || <span className={Classes.TEXT_MUTED}>Not set</span>}</td></tr>
        <tr><th scope="row">Sign-in</th><td>{loginTypeLabel(user.login_type) ?? '—'}</td></tr>
        <tr><th scope="row">Role</th><td>{user.is_admin ? 'Admin: you can manage users and the server' : 'User'}</td></tr>
      </tbody>
    </HTMLTable>
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 16, maxWidth: 600 }}>
      {login_type === 'LOCAL'
        ? "Ask an admin to change your name or email."
        : "Your name and email come from your company's directory: change them there."}
    </p>
  </section>;
};

export default ProfileTab;
