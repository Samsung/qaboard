import React from "react";
import { post, get } from "axios";
import { connect } from 'react-redux'
import {
  Classes,
  Intent,
  MenuItem,
  Icon,
  Tooltip,
  InputGroup,
  Button,
  Dialog,
  Toaster,
} from "@blueprintjs/core";
import { login, logout } from '../../actions/users'

// TODO:
// - connect  auth to the store, get user from there
// - check the flow
// - start-server.md add LDAP
// - sign-up ?

const toaster = Toaster.create();

class AuthButton extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loading: false,
    };
  }

  checkAuth = () => {
    get("/api/v1/user/me/")
    .then(response => {
      const { is_authenticated, user_id, user_name, full_name, email, is_ldap } = response.data;
      this.setState({
        is_loading: false,
      });
      if (is_authenticated) {
        this.props.dispatch(login({user_name, email, is_ldap, full_name, user_id}))
      } else {
        this.props.dispatch(logout())
      }
    })
    .catch(error => {
      toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 })
      console.log(error.response)
    })
  }

  componentDidMount() {
    if (!this.props.user.is_logged)
      this.checkAuth()
  }

  render() {
    if (this.state.loading)
      return <Button loading={true}/>

    console.log("user", this.props.user)
    return this.props.user?.is_authenticated ?
              <UserMenu user={this.props.user}/> 
            : <LoginButton
                user={this.props.user}
                dispatch={this.props.dispatch}
                appSider={this.props.appSider}
              />
  }
}


class UserMenu extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};

    this.handleLogOut = this.handleLogOut.bind(this);
  }

  handleLogOut = display_name => {
    post("/api/v1/user/logout/")
      .then(response => {
        if(response.status == 200){
          this.props.getAuth()
          toaster.show({ message: `Goodbye, ${display_name}`, intent: Intent.WARNING, timeout: 3000 });
        }
      })
      .catch(error => {
        toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 })
        console.log(error.response)
      })
  }

  render() {
    const { user_name, full_name } = this.props.user;
    const display_name = full_name ?? user_name
    return <>
        <MenuItem
          text={<Icon icon="user"iconSize={Icon.SIZE_LARGE}/>}
          defaultIsOpen
          popoverProps={{
            usePortal: true,
            // portalClassName: "limit-overflow",
            hoverCloseDelay: 1000,
            transitionDuration: 800,
          }}
          style={{textAlign: "center"}}
          >
          <li className={Classes.MENU_HEADER}><h6 className={Classes.HEADING}>{display_name}</h6></li>
          <MenuItem
            text={"Log Out"}
            icon={"log-out"}
            onClick={() => this.handleLogOut(display_name)}
          />
        </MenuItem>
    </>
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
      const { user_id, user_name, full_name, email, is_ldap } = response.data;
      toaster.show({ message: `Welcome, ${full_name ?? user_name}`, intent: Intent.SUCCESS, timeout: 3000 });
      this.props.dispatch(login({user_name, email, is_ldap, full_name, user_id}))
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
        toaster.show({ message: `ERROR: ${error_msg}`, intent: Intent.DANGER, timeout: 5000 })
      console.log(error.response)
      })
  }


  render() {
    const { error } = this.state;
    const warning_sign = <>
      <Tooltip content="Try your windows credentials" position="right" intent={Intent.DANGER} hoverCloseDelay={2000}>
          <Icon icon="warning-sign" iconSize={Icon.SIZE_LARGE} style={{transform: "translate(-50%, 50%)", color: "#f02849"}}/>
      </Tooltip>
      </>
    const warning = {
      rightElement: warning_sign,
      intent: Intent.DANGER,
    };

    const key_state = {
      onClick: this.handleOpen,
    };

    const login_button = this.props.appSider ?
      <MenuItem icon="log-in" text="Login" {...key_state}/> :
      <Button intent={Intent.PRIMARY} icon={<Icon icon="log-in" color="#fff"/>} style={{color : "#fff"}} text="Login" {...key_state}/>
    const logout_button = this.props.appSider ?
      <MenuItem icon="log-out" {...key_state} text="Logout"/> :
      <Button icon={<Icon icon="log-out" color="#fff"/>} style={{color : "#fff"}} {...key_state} text="Logout"/>
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
              <Button type="submit" large intent={Intent.PRIMARY} fill loading={this.state.is_loading}>
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
  
  handleOpen = () => this.setState({ isOpen: true , error: null, is_loading: false});
  handleClose = () => this.setState({ isOpen: false });
}


const mapStateToProps = state => {
  return {
    user: state.user || null,
  }
}
export default connect(mapStateToProps)(AuthButton);
