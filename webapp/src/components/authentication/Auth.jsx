import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import styled from "styled-components";
import {
  Classes,
  Intent,
  MenuItem,
  Icon,
  IconSize,
  InputGroup,
  Button,
  Dialog,
  FormGroup,
} from "@blueprintjs/core";
import { http, errorMessage } from "../../api/http";
import { userQuery, logged_out_user, setUser } from "../../api/queries";
import { useSiteConfig } from "../../hooks";
import { toaster } from "./../../toaster"
import { Avatar } from '../avatars';
import { colors, spacing, typography, borders, shadows, transitions } from '../../design/tokens';

// Modern styled components for user menu  
const UserMenuTrigger = styled.div`
  display: flex;
  align-items: center;
  gap: ${spacing.sm};
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  
  .user-display {
    font-size: ${typography.sm};
    font-weight: ${typography.medium};
    color: ${colors.textSecondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100px;
  }
  
  .chevron-icon {
    opacity: 0.5;
    margin-left: auto;
    transition: all ${transitions.hover};
  }
`;

const UserDropdownMenu = styled.div`
  background: ${colors.surface};
  border: ${borders.width.thin} solid ${colors.border};
  border-radius: ${borders.radius.md};
  box-shadow: ${shadows.lg};
  overflow: hidden;
  
  .bp6-menu {
    background: transparent;
    padding: 0;
  }
  
  .bp6-menu-item {
    background: transparent !important;
    border-radius: 0 !important;
    margin: 0 !important;
    padding: ${spacing.md} ${spacing.lg} !important;
    border-bottom: ${borders.width.thin} solid ${colors.borderLight} !important;
    color: ${colors.textSecondary} !important;
    transition: all ${transitions.hover} !important;
    
    &:last-child {
      border-bottom: none !important;
    }
    
    &:hover {
      background: ${colors.hover} !important;
      color: ${colors.textPrimary} !important;
    }
    
    &.bp6-intent-danger {
      color: ${colors.danger} !important;
      
      &:hover {
        background: rgba(255, 68, 68, 0.1) !important;
        color: ${colors.danger} !important;
      }
    }
    
    &:disabled {
      opacity: 0.5 !important;
      cursor: not-allowed !important;
      
      &:hover {
        background: transparent !important;
        color: ${colors.textMuted} !important;
      }
    }
    
    .bp6-icon {
      color: inherit !important;
      opacity: 0.8;
      margin-right: ${spacing.md} !important;
    }
  }
`;

const UserProfileHeader = styled.div`
  display: flex;
  align-items: center;
  gap: ${spacing.md};
  padding: ${spacing.lg};
  background: linear-gradient(135deg, ${colors.surface} 0%, ${colors.surfaceHover} 100%);
  border-bottom: ${borders.width.thin} solid ${colors.border};
`;

const UserInfo = styled.div`
  flex: 1;
  min-width: 0;
  
  .user-name {
    font-size: ${typography.base};
    font-weight: ${typography.semibold};
    color: ${colors.textPrimary};
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .user-email {
    font-size: ${typography.sm};
    color: ${colors.textSecondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

// Hide Blueprint's default submenu caret since we have our own
const UserMenuItemWrapper = styled.div`
  /* Hide the list marker bullet from the submenu li element */
  li.bp6-submenu {
    list-style: none !important;
  }
  
  /* Hide the submenu icon completely */
  .bp6-submenu-icon {
    display: none !important;
  }
  
  .user-menu-trigger {
    /* Hide Blueprint's default submenu caret */
    &::after {
      display: none !important;
    }
    
    /* Hide Blueprint's default submenu icon */
    .bp6-icon-caret-right {
      display: none !important;
    }
  }
`;

const AuthButton = ({ appSider }) => {
  const queryClient = useQueryClient();
  // until we know who users are, we don't flash a "Log in" button
  const { data: known_user, isPending: user_pending } = useQuery(userQuery);
  const user = known_user ?? logged_out_user;
  const { login_type, avatar_url_template } = useSiteConfig();
  const [is_loading, setLoading] = useState(false);

  const logout = () => {
    const display_name = user.full_name ?? user.user_name;
    queryClient.setQueryData(userQuery.queryKey, logged_out_user);
    if (login_type === "SAML") {
      setLoading(true);
      toaster.show({ message: `Goodbye, ${display_name}`, intent: Intent.WARNING, timeout: 3000 });
      window.location.href = '/api/auth/saml20/login/?slo';
      return;
    }
    http.post("/api/v1/user/logout/")
      .then(() => {
        toaster.show({ message: `Goodbye, ${display_name}`, intent: Intent.WARNING, timeout: 3000 });
        setUser(queryClient, logged_out_user);
      })
      .catch(error => {
        toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 3000 });
      });
  };

  if (is_loading)
    return <Button loading={true}/>;
  if (user_pending)
    return appSider
      ? <MenuItem icon="log-in" text="Log in" className={Classes.SKELETON} disabled/>
      : <Button icon="log-in" text="Log in" className={Classes.SKELETON} disabled/>;
  return user.is_logged
    ? <UserMenu user={user} logout={logout} avatar_url_template={avatar_url_template}/>
    : <LoginButton user={user} logout={logout} appSider={appSider} login_type={login_type}/>;
};


const UserMenu = ({ user, logout, avatar_url_template }) => {
  const display_name = user.full_name || user.user_name;
  const avatarUrl = avatar_url_template ? avatar_url_template.replace('{user_name}', user.user_name) : null;
  return (
    <UserMenuItemWrapper>
      <MenuItem
        text={
          <UserMenuTrigger>
            <Avatar 
              src={avatarUrl}
              name={display_name}
              size="28px"
            />
            <span className="user-display">{display_name}</span>
            <Icon icon="chevron-down" className="chevron-icon" size={10} />
          </UserMenuTrigger>
        }
        popoverProps={{
          usePortal: true,
          hoverCloseDelay: 1000,
          transitionDuration: 200,
          // MenuItem's submenu already stays within the viewport
          placement: "right-start",
          popoverClassName: "user-menu-popover"
        }}
        style={{ 
          padding: `${spacing.sm} ${spacing.md}`,
          background: "transparent",
          border: "none",
          borderRadius: borders.radius.md
        }}
        className="user-menu-trigger"
      >
        <UserDropdownMenu>
          <UserProfileHeader>
            <Avatar 
              src={avatarUrl}
              name={display_name}
              size="36px"
            />
            <UserInfo>
              <div className="user-name">{display_name}</div>
              {user.email && <div className="user-email">{user.email}</div>}
            </UserInfo>
          </UserProfileHeader>
          <MenuItem
            text="Log out"
            icon="log-out"
            onClick={logout}
          />
        </UserDropdownMenu>
      </MenuItem>
    </UserMenuItemWrapper>
  );
};


const warning = {
  rightElement: <Icon icon="warning-sign" intent={Intent.DANGER} size={IconSize.LARGE} style={{transform: "translate(-50%, 50%)"}}/>,
  intent: Intent.DANGER,
};

const LoginButton = ({ user, logout, appSider, login_type }) => {
  const queryClient = useQueryClient();
  // the site's advice to users who can't log in (QABOARD_LOGIN_HINT), e.g. which credentials to use
  const { login_hint } = useSiteConfig();
  const [is_open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const [is_loading, setLoading] = useState(false);

  const handleSubmit = event => {
    event.preventDefault();
    const data = new FormData(event.target);
    setLoading(true);
    http.post("/api/v1/user/auth/", data)
      .then(response => {
        const { user_id, user_name, full_name, email, login_type } = response.data;
        toaster.show({ message: `Welcome, ${full_name ?? user_name}`, intent: Intent.SUCCESS, timeout: 3000 });
        setUser(queryClient, { ...logged_out_user, is_logged: true, user_name, email, login_type, full_name, user_id });
        setError(null);
        setLoading(false);
        setOpen(false);
      })
      .catch(error => {
        const error_msg = error.response?.data?.error ?? errorMessage(error);
        setError(error_msg);
        setLoading(false);
        if (!error_msg.startsWith('invalid'))
          toaster.show({ message: `Could not log in: ${error_msg}`, intent: Intent.DANGER, timeout: 10000 });
      });
  };

  const handleLogin = () => {
    if (login_type === "SAML") {
      setLoading(true);
      window.location.href = '/api/auth/saml20/login/?sso';
    } else {
      setOpen(true);
      setError(null);
      setLoading(false);
    }
  };

  const login_button = appSider ?
    <MenuItem icon="log-in" text="Log in" intent={Intent.PRIMARY} onClick={handleLogin}/> :
    <Button intent={Intent.PRIMARY} icon="log-in" text="Log in" onClick={handleLogin} loading={is_loading}/>;
  const logout_button = appSider ?
    <MenuItem icon="log-out" text="Log out" onClick={logout}/> :
    <Button icon="log-out" onClick={logout} text="Log out"/>;
  return <>
    {!user.is_logged ? login_button : logout_button}
    <Dialog
      icon="log-in"
      title="Log in"
      onClose={() => setOpen(false)}
      style={{ width: "396px" }}
      isOpen={is_open}
      canEscapeKeyClose
      canOutsideClickClose
      enforceFocus
      usePortal
    >
      <form onSubmit={handleSubmit}>
        <div className={Classes.DIALOG_BODY}>
          <FormGroup
            style={{padding: "6px", marginBottom: 0}}
            intent={error === "invalid-username" ? Intent.DANGER : undefined}
            helperText={error === "invalid-username" ? <>This username does not match any user account.{login_hint && <> {login_hint}</>}</> : undefined}
          >
            <InputGroup id="username" name="username" type="text" placeholder="username" aria-label="Username" autoFocus large  {...(error === "invalid-username" && warning)}/>
          </FormGroup>
          <FormGroup
            style={{padding: "6px", marginBottom: 0}}
            intent={error === "invalid-password" ? Intent.DANGER : undefined}
            helperText={error === "invalid-password" ? <>The password is incorrect.{login_hint && <> {login_hint}</>}</> : undefined}
          >
            <InputGroup id="password" name="password" type="password" placeholder="********" aria-label="Password" large {...(error === "invalid-password" && warning)}/>
          </FormGroup>
          <div style={{padding: "6px"}} >
            <Button type="submit" large intent={Intent.PRIMARY} fill loading={is_loading}>
              <b>Log in</b>
            </Button>
          </div>
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          </div>
        </div>
      </form>
    </Dialog>
  </>;
};

export default AuthButton;
