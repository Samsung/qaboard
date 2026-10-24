import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import styled from "styled-components";
import {
  AnchorButton,
  Classes,
  Intent,
  MenuItem,
  Icon,
  Button,
  Menu,
  Popover,
  Tag,
} from "@blueprintjs/core";
import { http, errorMessage, reason_messages } from "../../api/http";
import { userQuery, logged_out_user, setUser } from "../../api/queries";
import { useSiteConfig } from "../../hooks";
import { loginUrl } from "../../login/api";
import { requestLogin } from "./login";
import { accessRequestsQuery } from "../../admin/api";
import { history } from "../../router";
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

// Signs users out. With single sign-on, the identity provider signs them out too: `onLeave` while the page goes there.
export const useSignOut = ({ onLeave } = {}) => {
  const queryClient = useQueryClient();
  const user = useQuery(userQuery).data ?? logged_out_user;
  const { login_type } = useSiteConfig();
  return () => {
    const display_name = user.full_name ?? user.user_name;
    queryClient.setQueryData(userQuery.queryKey, logged_out_user);
    if (login_type === "SAML") {
      onLeave?.();
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
};

const AuthButton = ({ appSider }) => {
  // until we know who users are, we don't flash a "Sign in" button
  const { data: known_user, isPending: user_pending } = useQuery(userQuery);
  const user = known_user ?? logged_out_user;
  const { avatar_url_template } = useSiteConfig();
  const [is_loading, setLoading] = useState(false);
  const logout = useSignOut({ onLeave: () => setLoading(true) });

  if (is_loading)
    return <Button loading={true}/>;
  if (user_pending)
    return appSider
      ? <MenuItem icon="log-in" text="Sign in" className={Classes.SKELETON} disabled/>
      : <Button icon="log-in" text="Sign in" className={Classes.SKELETON} disabled/>;
  return user.is_logged
    ? <UserMenu user={user} logout={logout} avatar_url_template={avatar_url_template} appSider={appSider}/>
    : <LoginButton user={user} appSider={appSider}/>;
};


// Links in menus navigate without reloading the app, and still open in new tabs on middle- or ctrl-click
const navigate = path => event => {
  if (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  history.push(path);
};

// In the sidebar, a submenu that opens on hover. On the dark top bar of the projects list and the settings, a menu
// that opens on click, under its button, so that it doesn't hide it.
const UserMenu = ({ user, logout, avatar_url_template, appSider = false }) => {
  const display_name = user.full_name || user.user_name;
  const avatarUrl = avatar_url_template ? avatar_url_template.replace('{user_name}', user.user_name) : null;
  // admins see how many users wait for them
  const { data: requests } = useQuery({ ...accessRequestsQuery('pending', { background: true }), enabled: !!user.is_admin });
  const nb_pending = user.is_admin ? requests?.length ?? 0 : 0;
  const pending_tag = nb_pending > 0 && <Tag round intent={Intent.WARNING} title={`${nb_pending} access request${nb_pending === 1 ? '' : 's'} to review`}>{nb_pending}</Tag>;
  const trigger = <UserMenuTrigger>
    <Avatar src={avatarUrl} name={display_name} size="28px"/>
    <span className="user-display">{display_name}</span>
    {pending_tag}
    <Icon icon="chevron-down" className="chevron-icon" size={10} />
  </UserMenuTrigger>;
  const items = <>
    <MenuItem text="Settings" icon="cog" href="/settings" onClick={navigate("/settings")}/>
    <MenuItem text="Runs activity" icon="pulse" href="/activity" onClick={navigate("/activity")}/>
    <MenuItem text="Storage usage" icon="database" href="/storage" onClick={navigate("/storage")}/>
    {user.is_admin && <MenuItem
      text="Admin"
      icon="shield"
      href={nb_pending > 0 ? "/admin/requests" : "/admin"}
      onClick={navigate(nb_pending > 0 ? "/admin/requests" : "/admin")}
      labelElement={pending_tag || undefined}
    />}
    <MenuItem text="Sign out" icon="log-out" onClick={logout}/>
  </>;
  const header = <UserProfileHeader>
    <Avatar src={avatarUrl} name={display_name} size="36px"/>
    <UserInfo>
      <div className="user-name">{display_name}</div>
      {user.email && <div className="user-email">{user.email}</div>}
    </UserInfo>
  </UserProfileHeader>;

  if (!appSider)
    return <Popover
      placement="bottom-end"
      interactionKind="click"
      popoverClassName="user-menu-popover"
      content={<UserDropdownMenu>{header}<Menu>{items}</Menu></UserDropdownMenu>}
    >
      <Button variant="minimal" aria-label={`${display_name}: your account`} style={{ padding: `0 ${spacing.sm}` }}>{trigger}</Button>
    </Popover>;

  return (
    <UserMenuItemWrapper>
      <MenuItem
        text={trigger}
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
          {header}
          {items}
        </UserDropdownMenu>
      </MenuItem>
    </UserMenuItemWrapper>
  );
};


// Accounts that can't use the server, from /me
const account_reasons = ["user_disabled", "user_pending"];

// Signing in happens on /login, which comes back here. Disabled and pending users see why they were signed out:
// the sign-in page explains it, and shows pending users their access request.
const LoginButton = ({ user, appSider }) => {
  // the current page when clicked: also outside of the router (tests)
  const href = loginUrl();
  const onClick = event => {
    if (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    requestLogin();
  };
  const button_props = account_reasons.includes(user.reason)
    ? { icon: user.reason === "user_pending" ? "time" : "blocked-person", intent: user.reason === "user_pending" ? Intent.WARNING : Intent.DANGER, text: user.reason === "user_pending" ? "Account pending" : "Account disabled", title: user.error || reason_messages[user.reason] }
    : { icon: "log-in", intent: Intent.PRIMARY, text: "Sign in" };
  return appSider
    ? <MenuItem {...button_props} href={href} onClick={onClick}/>
    : <AnchorButton {...button_props} href={href} onClick={onClick}/>;
};

export default AuthButton;
