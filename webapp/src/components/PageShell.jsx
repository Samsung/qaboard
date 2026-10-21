// The app's own pages (settings, admin, device approval): a bar like the projects list's, a title, the content.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alignment, Button, Callout, Classes, Icon, Intent, Navbar, NavbarDivider, NavbarGroup, NavbarHeading, NonIdealState,
} from "@blueprintjs/core";
import styled from "styled-components";

import { history, Link } from "../router";
import { userQuery, logged_out_user } from "../api/queries";
import { errorMessage } from "../api/http";
import AuthButton from "./authentication/Auth";
import { AccountCallout } from "./authentication/PrivateContent";
import { requestLogin } from "./authentication/login";
import { loginUrl } from "../login/api";
import { ThemeButton } from "./ThemeButton";
import Footer from "./Footer";
import EmptyLoading from "./EmptyLoading";


// On narrow screens the bar's groups wrap on several rows instead of overflowing the page
export const WrappingNavbar = styled(Navbar)`
  && {
    height: auto;
    min-height: 50px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    column-gap: 8px;
  }
  && > .${Classes.NAVBAR_GROUP} {
    float: none;
    height: auto;
    min-height: 50px;
    flex-wrap: wrap;
    min-width: 0;
  }
  && > .${Classes.ALIGN_RIGHT} {
    margin-left: auto;
  }
`;

// Tabs scroll sideways on narrow screens, instead of the whole page
export const ScrollingTabs = styled.div`
  overflow-x: auto;
  overflow-y: hidden;
  max-width: 100%;
  .${Classes.TAB_LIST} {
    width: max-content;
  }
`;

const Content = styled.main`
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: ${props => props.$wide ? '1400px' : '1100px'};
  margin: 0 auto;
  padding: 24px clamp(16px, 4%, 48px) 40px;

  .qa-page-title {
    margin: 0 0 4px;
  }
  .qa-page-description {
    margin: 0 0 24px;
  }
`;

const nav_link_style = { color: '#fff' };

// `account`: the account menu, or the "Sign in" button (not on the sign-in page itself)
export const PageShell = ({ title, description, wide = false, account = true, children }) => <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--qa-background)', minWidth: 0 }}>
  <WrappingNavbar className={Classes.DARK}>
    <NavbarGroup align={Alignment.LEFT}>
      <NavbarHeading><Link to="/" style={{ ...nav_link_style, fontWeight: 'bold' }}>QA-Board</Link></NavbarHeading>
      <NavbarDivider/>
      <Link to="/" className={`${Classes.BUTTON} ${Classes.MINIMAL}`} style={nav_link_style}>
        <Icon icon="projects" color="#fff"/><span className={Classes.BUTTON_TEXT}>Projects</span>
      </Link>
    </NavbarGroup>
    <NavbarGroup align={Alignment.RIGHT}>
      <ThemeButton style={account ? { marginRight: '10px' } : undefined}/>
      {account && <AuthButton/>}
    </NavbarGroup>
  </WrappingNavbar>
  <Content $wide={wide}>
    {title && <h2 className={`${Classes.HEADING} qa-page-title`}>{title}</h2>}
    {description && <p className={`${Classes.TEXT_MUTED} qa-page-description`}>{description}</p>}
    {children}
  </Content>
  <Footer/>
</div>;


// Signed-out users are checked again each time, like in PrivateContent
const refetchOnMount = query => query.state.data?.is_logged ? true : 'always';

// Pages about the user need one: else they go to /login, and come back to the page once signed in.
// `children` is a function of the user.
export const RequireLogin = ({ what = "see this page", children }) => {
  const { data: user = logged_out_user, isPending, error, refetch } = useQuery({ ...userQuery, refetchOnMount });
  const to_login = !isPending && !error && !user.is_logged && !user.reason;
  useEffect(() => { if (to_login) history.replace(loginUrl()); }, [to_login]);
  if (isPending)
    return <EmptyLoading/>;
  if (error && !user.is_logged)
    return <Callout intent={Intent.DANGER} title="Could not check who you are">
      <p>{errorMessage(error)}</p>
      <Button icon="refresh" text="Retry" onClick={() => refetch()}/>
    </Callout>;
  if (user.reason)
    return <AccountCallout user={user}/>;
  if (!user.is_logged)
    // while we go to the sign-in page
    return <NonIdealState
      icon="log-in"
      title="Sign in to continue"
      description={`Sign in to ${what}.`}
      action={<Button intent={Intent.PRIMARY} icon="log-in" text="Sign in" onClick={requestLogin}/>}
    />;
  return children(user);
};

export default PageShell;
