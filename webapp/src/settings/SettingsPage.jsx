// /settings: the user's profile, preferences, sign-in methods, sessions, access tokens, CLI sign-ins and activity.
// The tab is in the URL.
import { Tab, Tabs } from "@blueprintjs/core";

import { useRouter } from "../router";
import { PageShell, RequireLogin, ScrollingTabs } from "../components/PageShell";
import { ProfileTab } from "./ProfileTab";
import { PreferencesTab } from "./PreferencesTab";
import { TokensTab } from "./TokensTab";
import { CliTab } from "./CliTab";
import { ActivityTab } from "./ActivityTab";
import { SignInTab } from "./SignInTab";
import { SessionsTab } from "./SessionsTab";


export const tabs = [
  { id: 'profile', title: 'Profile', icon: 'person', Panel: ProfileTab },
  { id: 'preferences', title: 'Preferences', icon: 'settings', Panel: PreferencesTab },
  { id: 'sign-in', title: 'Sign-in methods', icon: 'log-in', Panel: SignInTab },
  { id: 'sessions', title: 'Sessions', icon: 'desktop', Panel: SessionsTab },
  { id: 'tokens', title: 'Access tokens', icon: 'key', Panel: TokensTab },
  { id: 'cli', title: 'CLI sign-ins', icon: 'console', Panel: CliTab },
  { id: 'activity', title: 'Activity', icon: 'history', Panel: ActivityTab },
];

export const SettingsPage = () => {
  const { match, history } = useRouter();
  const selected = tabs.find(tab => tab.id === match.params?.tab) ?? tabs[0];
  const { Panel } = selected;
  return <PageShell title="Settings">
    <RequireLogin what="see your settings">
      {user => <>
        <ScrollingTabs>
          <Tabs
            id="settings-tabs"
            selectedTabId={selected.id}
            onChange={id => history.push(`/settings/${id}`)}
            size="large"
          >
            {tabs.map(tab => <Tab key={tab.id} id={tab.id} title={tab.title} icon={tab.icon}/>)}
          </Tabs>
        </ScrollingTabs>
        <div style={{ marginTop: 20, minWidth: 0 }}>
          <Panel user={user}/>
        </div>
      </>}
    </RequireLogin>
  </PageShell>;
};

export default SettingsPage;
