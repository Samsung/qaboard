import React from "react";
import { post, get } from "axios";
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

const toaster = Toaster.create();


class Auth extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      is_authenticated: false,
      user_id: '',
      user_name: '',
      forename: '',
      surname: '',
      email : '',
      is_ldap : false,
    };

    this.getAuth = this.getAuth.bind(this);
  }

  getAuth() {
    get("/api/v1/user/get-auth/")
    .then(response => {
      const {
        is_authenticated,
        user_id,
        user_name,
        forename,
        surname,
        email ,
        is_ldap,
      } = response.data;
      
      this.setState({
        is_authenticated,
        user_id,
        user_name,
        forename,
        surname,
        email ,
        is_ldap
      });
    })
    .catch(error => {
      toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 })
      console.log(error.response)
    })
  }


  componentDidMount() {
    // check against session cookie?
    this.getAuth()
  }

  // check against session cookie?
  // check on componentDidUpdate?
  /*
  componentDidUpdate() {
    this.getAuth()
  }
  */

  render() {
    const {
      is_authenticated,
    } = this.state;

    const app_sider = this.props.appSider;

    const display = is_authenticated ? <UserMenu getAuth={this.getAuth} {...this.state}/> : <Login getAuth={this.getAuth} appSider={app_sider} {...this.state}/>

    return <>
      {display}
    </>
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
    const {
      user_name,
      forename,
      surname,
    } = this.props;

    const display_name = forename && surname ? `${forename} ${surname}` : user_name

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


class Login extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      canEscapeKeyClose: true,
      canOutsideClickClose: true,
      enforceFocus: true,
      isOpen: false,
      usePortal: true,
      invalid_username : false,
      invalid_password : false,
      is_loading: false,
    };

    this.handleSubmit = this.handleSubmit.bind(this);
  }

  handleSubmit(event) {
    event.preventDefault();
    const data = new FormData(event.target);
    this.setState({is_loading: true});

      post("/api/v1/user/auth/", data)
      .then(response => {
        if(response.status == 200){
          this.props.getAuth()
          this.handleClose()
          const display_name = response.data.full_name || response.data.user_name
          toaster.show({ message: `Welcome, ${display_name}`, intent: Intent.SUCCESS, timeout: 3000 });
        }
      })
      .catch(error => {
        const {
          invalid_username,
          invalid_password,
        } = error.response.data;

        this.setState({
          invalid_username,
          invalid_password,
          is_loading: false,
        });

        toaster.show({ message: `${error}. ${error.response.data.error}`, intent: Intent.DANGER, timeout: 5000 , allowHtml: true })
        console.log(error.response)
      })
  }


  render() {
    const {
      invalid_username,
      invalid_password,
    } = this.state;
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
      text: "Log in",
      onClick: this.handleOpen,
    };

    const key = this.props.appSider ?
      <MenuItem icon="log-in" {...key_state}/> :
      <Button className={Classes.MINIMAL} icon={<Icon icon="log-in" color="#106ba3"/>} style={{color : "#0d4975"}} {...key_state}/>

    return <>
      {key}
      <Dialog
          icon="log-in"
          title="Log Into QA-Board"
          onClose={this.handleClose}
          style={{ width: "396px" }}
          {...this.state}
      >
        <form onSubmit={this.handleSubmit}>
          <div className={Classes.DIALOG_BODY}>
            {/* <div style={{padding: "16px 0 16px 0"}}>
              <p style={{textAlign: "center", fontSize: "large"}}>Log Into QA-Board</p>
            </div> */}
            <div style={{padding: "6px"}}>
              <InputGroup id="username" name="username" type="text" placeholder="User Name" autoFocus={true} large={true}  {...invalid_username && warning}/>
              {invalid_username && <div style={{color: "#f02849", margin: "8px"}}>The user name you’ve entered doesn’t match any account.</div>}
            </div>
            <div style={{padding: "6px"}}>
              <InputGroup id="password" name="password" type="password" placeholder="Password" large={true} {...invalid_password && warning}/>
              {invalid_password && <div style={{color: "#f02849", margin: "8px"}}>The password you’ve entered is incorrect.</div>}
            </div>
            <div style={{padding: "6px"}} >
              <Button type="submit" large={true} intent={Intent.PRIMARY} fill={true} loading={this.state.is_loading}><b>Log In</b></Button>
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
  
  handleOpen = () => this.setState({ isOpen: true , invalid_username : false, invalid_password : false});
  handleClose = () => this.setState({ isOpen: false });
}


export { Auth };
