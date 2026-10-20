// /admin: for admins only. The server decides who they are (`is_admin` from /api/v1/user/me/), and checks each call.
import { Tab, Tabs } from "@blueprintjs/core";

import { useRouter } from "../router";
import { NotAdmin } from "./states";
import { PageShell, RequireLogin } from "../components/PageShell";
import { Overview } from "./Overview";
import { Users } from "./Users";
import { UserDetail } from "./UserDetail";
import { AdminTokens } from "./Tokens";
import { Audit } from "./Audit";
import { Settings } from "./Settings";


const sections = [
  { id: 'overview', title: 'Overview', icon: 'dashboard', Panel: Overview },
  { id: 'users', title: 'Users', icon: 'people', Panel: Users },
  { id: 'tokens', title: 'Tokens', icon: 'key', Panel: AdminTokens },
  { id: 'audit', title: 'Audit', icon: 'history', Panel: Audit },
  { id: 'settings', title: 'Settings', icon: 'cog', Panel: Settings },
];

export const AdminPage = () => {
  const { match, history } = useRouter();
  const user_id = match.params?.user_id;
  const selected = user_id ? sections[1] : sections.find(section => section.id === match.params?.section) ?? sections[0];
  const { Panel } = selected;
  return <PageShell title="Admin" wide>
    <RequireLogin what="administer QA-Board">
      {me => !me.is_admin ? <NotAdmin/> : <>
        <Tabs
          id="admin-tabs"
          selectedTabId={selected.id}
          onChange={id => history.push(`/admin/${id}`)}
          size="large"
        >
          {sections.map(section => <Tab key={section.id} id={section.id} title={section.title} icon={section.icon}/>)}
        </Tabs>
        <div style={{ marginTop: 20 }}>
          {user_id ? <UserDetail id={user_id} me={me}/> : <Panel me={me}/>}
        </div>
      </>}
    </RequireLogin>
  </PageShell>;
};

export default AdminPage;
