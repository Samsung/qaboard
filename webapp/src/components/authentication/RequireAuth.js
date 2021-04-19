import React from "react";
import { connect } from 'react-redux'
import {
  Classes,
  Intent,
  Callout,
} from "@blueprintjs/core";
import AuthButton from "./Auth"



class PrivateContent extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    const is_logged = this.props.user ? this.props.user.is_logged : undefined;
    return <>
    {is_logged ?
    this.props.children :
    <Callout intent={Intent.PRIMARY}>
    <h4 className={Classes.HEADING}>The content is available for logged-in users only.</h4>
      <AuthButton/>
    </Callout>
    }
    </>
  }
}


// export const require_authentication_button = ( on_click_func, user_state ) => {
//   // const user_state = store ? store.getState().user : undefined
//   const is_auth = user_state ? user_state.is_logged : undefined
//   return is_auth ? on_click_func : undefined
// }


const mapStateToProps = state => {
  return {
    user: state.user || null,
  }
}

export default connect(mapStateToProps)(PrivateContent);