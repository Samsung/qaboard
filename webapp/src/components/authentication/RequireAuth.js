import React from "react";
import { get } from "axios";
import { connect } from 'react-redux'
import {
  Classes,
  Intent,
  Callout,
  Toaster,
} from "@blueprintjs/core";
import AuthButton from "./Auth"
import { login, logout } from '../../actions/users'

const toaster = Toaster.create();


class PrivateContent extends React.Component {
  constructor(props) {
    super(props);
  }

  checkAuth = () => {
    get("/api/v1/user/me/")
    .then(response => {
      const { is_authenticated, user_id, user_name, full_name, email, is_ldap, is_sso } = response.data;
      if (is_authenticated) {
        this.props.dispatch(login({user_name, email, is_ldap, is_sso, full_name, user_id}))
      } 
      else {
        this.props.dispatch(logout())
      }
    })
    .catch(error => {
      toaster.show({ message: `${error}`, intent: Intent.DANGER, timeout: 3000 })
      console.log(error.response)
    })
  }


  componentDidMount() {
    const is_logged = this.props.user ? this.props.user.is_logged : undefined;
    if (!is_logged) {
      this.checkAuth()
    }
  }

  render() {
    const {enabled} = this.props
    const is_logged = this.props.user ? this.props.user.is_logged : undefined;
    return <>
      {is_logged || !enabled ?
      this.props.children :
        <Callout intent={Intent.PRIMARY}>
        <h4 className={Classes.HEADING}>The content is available for logged-in users only.</h4>
          <AuthButton/>
        </Callout>
    }
    </>
  }
}


const mapStateToProps = state => {
  return {
    user: state.user || null,
  }
}

export default connect(mapStateToProps)(PrivateContent);