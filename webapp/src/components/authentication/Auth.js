import React from "react";
import { post } from "axios";
import { connect } from 'react-redux'
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
import { login, logout } from '../../actions/users'
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
  
  .bp5-menu {
    background: transparent;
    padding: 0;
  }
  
  .bp5-menu-item {
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
    
    &.bp5-intent-danger {
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
    
    .bp5-icon {
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
  li.bp5-submenu {
    list-style: none !important;
  }
  
  /* Hide the submenu icon completely */
  .bp5-submenu-icon {
    display: none !important;
  }
  
  .user-menu-trigger {
    /* Hide Blueprint's default submenu caret */
    &::after {
      display: none !important;
    }
    
    /* Hide Blueprint's default submenu icon */
    .bp5-icon-caret-right {
      display: none !important;
    }
  }
`;

// TODO:
// - sign-up ?
// - move login/logout to the action

class AuthButton extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loading: false,
    };
  }

  logout = () => {
    const { user_name, full_name } = this.props.user;
    const display_name = full_name ?? user_name
    this.props.dispatch(logout())
    if (this.props.login_type === "SAML") {
      this.setState({is_loading: true});
      toaster.show({ message: `Goodbye, ${display_name}`, intent: Intent.WARNING, timeout: 3000 });
      window.location.href = '/api/auth/saml20/login/?slo';
    }
    else {
      post("/api/v1/user/logout/")
      .then(response => {
        if(response.status == 200){
          // this.props.getAuth()
          toaster.show({ message: `Goodbye, ${display_name}`, intent: Intent.WARNING, timeout: 3000 });
        }
      })
      .catch(error => {
        toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 })
        console.log(error.response)
      })
    }
  }

  render() {
    if (this.state.loading)
      return <Button loading={true}/>

    return this.props.user?.is_logged ?
              <UserMenu
                user={this.props.user}
                logout={this.logout}
                avatar_url_template={this.props.avatar_url_template}
              />
            : <LoginButton
                user={this.props.user}
                dispatch={this.props.dispatch}
                logout={this.logout}
                appSider={this.props.appSider}
                login_type={this.props.login_type}
              />
  }
}


class UserMenu extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  render() {
    const { user, logout } = this.props;
    const display_name = user.full_name || user.user_name;
    
    const avatarUrl = this.props.avatar_url_template
      ? this.props.avatar_url_template.replace('{user_name}', user.user_name)
      : null;
    return (
      <UserMenuItemWrapper>
        <MenuItem
          text={
            <UserMenuTrigger>
              <Avatar 
                src={avatarUrl}
                alt={display_name}
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
                alt={display_name}
                size="36px"
              />
              <UserInfo>
                <div className="user-name">{display_name}</div>
                {user.email && <div className="user-email">{user.email}</div>}
              </UserInfo>
            </UserProfileHeader>
            
            {/* <MenuItem
              text="Account Settings"
              icon="user"
              disabled
            />
            
            <MenuItem
              text="Preferences" 
              icon="cog"
              disabled
            /> */}
            
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
  }
}


class LoginButton extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      canEscapeKeyClose: true,
      canOutsideClickClose: true,
      enforceFocus: true,
      isOpen: false,
      usePortal: true,
      error : null,
      is_loading: false,
    };
  }

  handleSubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    this.setState({is_loading: true});

    post("/api/v1/user/auth/", data)
    .then(response => {
      const { user_id, user_name, full_name, email, login_type } = response.data;
      toaster.show({ message: `Welcome, ${full_name ?? user_name}`, intent: Intent.SUCCESS, timeout: 3000 });
      this.props.dispatch(login({user_name, email, login_type, full_name, user_id}))
      this.setState({
        error: null,
        is_loading: false,
        isOpen: false,
      });
    })
    .catch(error => {
      let error_msg = error.response?.data?.error ?? "unknown-error"
      this.setState({
        error: error_msg,
        is_loading: false,
      });
      if (!error_msg.startsWith('invalid'))
        toaster.show({ message: `ERROR: ${error_msg}`, intent: Intent.DANGER, timeout: 10000 })
      console.log(error.response)
      })
  }


  render() {
    const { error, is_loading } = this.state;
    const warning_sign = <>
      <Tooltip content="Try your windows credentials" position="right" intent={Intent.DANGER} hoverCloseDelay={2000}>
          <Icon icon="warning-sign" size={IconSize.LARGE} style={{transform: "translate(-50%, 50%)", color: "#f02849"}}/>
      </Tooltip>
      </>
    const warning = {
      rightElement: warning_sign,
      intent: Intent.DANGER,
    };


    const login_button = this.props.appSider ?
      <MenuItem icon="log-in" text="Login" intent={Intent.PRIMARY} onClick={this.handleLogin}/> :
      <Button intent={Intent.PRIMARY} icon={<Icon icon="log-in" color="#fff"/>} style={{color : "#fff"}} text="Login" onClick={this.handleLogin} loading={is_loading}/>
    const logout_button = this.props.appSider ?
      <MenuItem icon="log-out" text="Logout" onClick={this.props.logout}/> :
      <Button icon={<Icon icon="log-out" color="#fff"/>} style={{color : "#fff"}} onClick={this.props.logout} text="Logout"/>
    return <>
      {!this.props.user.is_logged ? login_button : logout_button}
      <Dialog
          icon="log-in"
          title="Login"
          onClose={this.handleClose}
          style={{ width: "396px" }}
          {...this.state}
      >
        <form onSubmit={this.handleSubmit}>
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
    </>
  }


  handleLogin = () => {
    if (this.props.login_type === "SAML") {
      this.setState({is_loading: true});
      window.location.href = '/api/auth/saml20/login/?sso';
    }
    else {
      this.handleOpen()
    }
  }

  handleOpen = () => this.setState({ isOpen: true , error: null, is_loading: false});
  handleClose = () => this.setState({ isOpen: false });
}


const mapStateToProps = state => {
  return {
    user: state.user || null,
    login_type: state.siteConfig.login_type,
    avatar_url_template: state.siteConfig.avatar_url_template,
  }
}
export default connect(mapStateToProps)(AuthButton);
