import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import styled from "styled-components";
import {
  Classes,
  Intent,
  MenuItem,
  Icon,
  IconSize,
  Tooltip,
  InputGroup,
  Button,
  Dialog,
} from "@blueprintjs/core";
import { http, errorMessage } from "../../api/http";
import { userQuery, logged_out_user, setUser } from "../../api/queries";
import { useSiteConfig, useUser } from "../../hooks";
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
  const user = useUser();
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
          position: "right-top",
          modifiers: {
            preventOverflow: { boundariesElement: "viewport" }
          },
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
            text="Sign Out"
            icon="log-out"
            intent={Intent.DANGER}
            onClick={logout}
          />
        </UserDropdownMenu>
      </MenuItem>
    </UserMenuItemWrapper>
  );
};


const warning = {
  rightElement: <Tooltip content="Try your windows credentials" position="right" intent={Intent.DANGER} hoverCloseDelay={2000}>
    <Icon icon="warning-sign" size={IconSize.LARGE} style={{transform: "translate(-50%, 50%)", color: "#f02849"}}/>
  </Tooltip>,
  intent: Intent.DANGER,
};

const LoginButton = ({ user, logout, appSider, login_type }) => {
  const queryClient = useQueryClient();
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
        const error_msg = error.response?.data?.error ?? "unknown-error";
        setError(error_msg);
        setLoading(false);
        if (!error_msg.startsWith('invalid'))
          toaster.show({ message: `ERROR: ${error_msg}`, intent: Intent.DANGER, timeout: 10000 });
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
    <MenuItem icon="log-in" text="Login" intent={Intent.PRIMARY} onClick={handleLogin}/> :
    <Button intent={Intent.PRIMARY} icon={<Icon icon="log-in" color="#fff"/>} style={{color : "#fff"}} text="Login" onClick={handleLogin} loading={is_loading}/>;
  const logout_button = appSider ?
    <MenuItem icon="log-out" text="Logout" onClick={logout}/> :
    <Button icon={<Icon icon="log-out" color="#fff"/>} style={{color : "#fff"}} onClick={logout} text="Logout"/>;
  return <>
    {!user.is_logged ? login_button : logout_button}
    <Dialog
      icon="log-in"
      title="Login"
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
          <div style={{padding: "6px"}}>
            <InputGroup id="username" name="username" type="text" placeholder="username" autoFocus large  {...(error === "invalid-username" && warning)}/>
            {error === "invalid-username" && <div style={{color: "#f02849", margin: "8px"}}>This username does not match any user account.</div>}
          </div>
          <div style={{padding: "6px"}}>
            <InputGroup id="password" name="password" type="password" placeholder="********" large {...(error === "invalid-password" && warning)}/>
            {error === "invalid-password" && <div style={{color: "#f02849", margin: "8px"}}>The password is incorrect.</div>}
          </div>
          <div style={{padding: "6px"}} >
            <Button type="submit" large intent={Intent.PRIMARY} fill loading={is_loading}>
              <b>Log In</b>
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
