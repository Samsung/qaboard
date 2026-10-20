// The app's own pages (settings, admin, device approval): a bar like the projects list's, a title, the content.
import { useQuery } from "@tanstack/react-query";
import {
  Alignment, Button, Callout, Classes, Icon, Intent, Navbar, NavbarDivider, NavbarGroup, NavbarHeading, NonIdealState,
} from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { userQuery, logged_out_user } from "../api/queries";
import { errorMessage } from "../api/http";
import AuthButton from "./authentication/Auth";
import { AccountCallout } from "./authentication/PrivateContent";
import { requestLogin } from "./authentication/login";
import { ThemeButton } from "./ThemeButton";
import Footer from "./Footer";
import EmptyLoading from "./EmptyLoading";


const Content = styled.main`
  box-sizing: border-box;
  width: 100%;
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

export const PageShell = ({ title, description, wide = false, children }) => <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--qa-background)' }}>
  <Navbar className={Classes.DARK}>
    <NavbarGroup align={Alignment.LEFT}>
      <NavbarHeading><Link to="/" style={{ ...nav_link_style, fontWeight: 'bold' }}>QA-Board</Link></NavbarHeading>
      <NavbarDivider/>
      <Link to="/" className={`${Classes.BUTTON} ${Classes.MINIMAL}`} style={nav_link_style}>
        <Icon icon="projects" color="#fff"/><span className={Classes.BUTTON_TEXT}>Projects</span>
      </Link>
    </NavbarGroup>
    <NavbarGroup align={Alignment.RIGHT}>
      <ThemeButton style={{ marginRight: '10px' }}/>
      <AuthButton/>
    </NavbarGroup>
  </Navbar>
  <Content $wide={wide}>
    {title && <h2 className={`${Classes.HEADING} qa-page-title`}>{title}</h2>}
    {description && <p className={`${Classes.TEXT_MUTED} qa-page-description`}>{description}</p>}
    {children}
  </Content>
  <Footer/>
</div>;


// Logged-out users are checked again each time, like in PrivateContent
const refetchOnMount = query => query.state.data?.is_logged ? true : 'always';

// Pages about the user need one: else we ask them to log in, and they stay on the page once they have.
// `children` is a function of the user.
export const RequireLogin = ({ what = "see this page", children }) => {
  const { data: user = logged_out_user, isPending, error, refetch } = useQuery({ ...userQuery, refetchOnMount });
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
    return <NonIdealState
      icon="log-in"
      title="Log in to continue"
      description={`Log in to ${what}.`}
      action={<Button intent={Intent.PRIMARY} icon="log-in" text="Log in" onClick={requestLogin}/>}
    />;
  return children(user);
};

export default PageShell;
