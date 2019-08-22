import {
  UPDATE_SELECTED,
} from './constants'


export const updateSelected = (project, selected) => {
  // TODO: add the URL sync logic..
  //   let query = qs.parse(window.location.search.substring(1));
  //   this.props.history.push({
  //   pathname: window.location.pathname,
  //   search: qs.stringify({
  //     ...query,
  //     [attribute_url || attribute]: value, // selected has missing data... we can define the mapping here 
  //   })
  // });
  // TODO: remove this logic from AppNavBar...
  return {
    type: UPDATE_SELECTED,
    project,
    selected,   
  }
}

