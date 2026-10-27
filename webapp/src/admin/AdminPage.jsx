// /admin: for admins only. The server decides who they are (`is_admin` from /api/v1/user/me/), and checks each call.
import { useQuery } from "@tanstack/react-query";
import { Intent, Tab, Tabs } from "@blueprintjs/core";

import { useRouter } from "../router";
import { NotAdmin } from "./states";
import { PageShell, RequireLogin, ScrollingTabs } from "../components/PageShell";
import { Overview } from "./Overview";
import { Users } from "./Users";
import { UserDetail } from "./UserDetail";
import { Groups, GroupDetail } from "./Groups";
import { AdminTokens } from "./Tokens";
import { ServiceAccounts } from "../access/ServiceAccounts";
import { Audit } from "./Audit";
import { Settings } from "./Settings";
import { SignIn } from "./SignIn";
import { AccessRequests } from "./AccessRequests";
import { Storage } from "./Storage";
import { JobDetail } from "./JobDetail";
import { ScanExplorer } from "./ScanExplorer";
import { accessRequestsQuery } from "./api";


// the instance's: projects' owners manage theirs from the project's Access page
const InstanceServiceAccounts = () => <ServiceAccounts project={null}/>;

const sections = [
  { id: 'overview', title: 'Overview', icon: 'dashboard', Panel: Overview },
  { id: 'users', title: 'Users', icon: 'people', Panel: Users },
  { id: 'groups', title: 'Groups', icon: 'inherited-group', Panel: Groups },
  { id: 'requests', title: 'Access requests', icon: 'endorsed', Panel: AccessRequests },
  { id: 'sign-in', title: 'Sign-in', icon: 'log-in', Panel: SignIn },
  { id: 'tokens', title: 'Tokens', icon: 'key', Panel: AdminTokens },
  { id: 'service-accounts', title: 'Service accounts', icon: 'build', Panel: InstanceServiceAccounts },
  { id: 'storage', title: 'Storage', icon: 'database', Panel: Storage },
  { id: 'audit', title: 'Audit', icon: 'history', Panel: Audit },
  { id: 'settings', title: 'Settings', icon: 'cog', Panel: Settings },
];

// The tabs, and the selected one. Users waiting for an admin are counted on their tab.
const AdminSections = ({ me, selected, user_id, group_id, job_id, scan_id, history }) => {
  const { data: requests } = useQuery(accessRequestsQuery('pending', { background: true }));
  const nb_pending = requests?.length ?? 0;
  const { Panel } = selected;
  return <>
    <ScrollingTabs>
      <Tabs
        id="admin-tabs"
        selectedTabId={selected.id}
        onChange={id => history.push(`/admin/${id}`)}
        size="large"
      >
        {sections.map(section => <Tab
          key={section.id}
          id={section.id}
          title={section.title}
          icon={section.icon}
          {...(section.id === 'requests' && nb_pending > 0 ? { tagContent: nb_pending, tagProps: { intent: Intent.WARNING, round: true, 'aria-label': `${nb_pending} pending` } } : {})}
        />)}
      </Tabs>
    </ScrollingTabs>
    <div style={{ marginTop: 20, minWidth: 0 }}>
      {user_id ? <UserDetail id={user_id} me={me}/> : group_id ? <GroupDetail id={group_id}/> : job_id ? <JobDetail id={job_id}/> : scan_id ? <ScanExplorer id={scan_id}/> : <Panel me={me}/>}
    </div>
  </>;
};

export const AdminPage = () => {
  const { match, history } = useRouter();
  const user_id = match.params?.user_id;
  const group_id = match.params?.group_id;
  const job_id = match.params?.job_id;
  const scan_id = match.params?.scan_id;
  const section_id = user_id ? 'users' : group_id ? 'groups' : job_id || scan_id ? 'storage' : match.params?.section;
  const selected = sections.find(section => section.id === section_id) ?? sections[0];
  return <PageShell title="Admin" wide>
    <RequireLogin what="administer QA-Board">
      {me => !me.is_admin ? <NotAdmin/> : <AdminSections me={me} selected={selected} user_id={user_id} group_id={group_id} job_id={job_id} scan_id={scan_id} history={history}/>}
    </RequireLogin>
  </PageShell>;
};

export default AdminPage;
