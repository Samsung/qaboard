import React, { Component } from "react";
import { get, post } from "axios";

import { CopyToClipboard } from "react-copy-to-clipboard";

import MonacoEditor from 'react-monaco-editor';

import {
  Classes,
  Callout,
  Intent,
  Spinner,
  NonIdealState,
  Button,
  Tag,
  Toaster,
  Tab,
  Tabs,
  Icon,
  Tooltip
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";

export const toaster = Toaster.create();

const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
  renderWhitespace: "all",
  //renderSideBySide: false
};


class AddRecordingsForm extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: true,
      error: null,
      files: {},
      groups: {},
      dirty: {},
      submitted: {},
      overwrite: false,
      selected_group_info: {
        number_of_tests: 0
      },
      selected_group_info_loading: false,
      selectedTabId: null,
    };
  }
 
  componentDidMount() {
    const { available_tests_files } = this.props;
    this.setState({ selectedTabId: "usr", files: available_tests_files }, () =>
    Object.entries(this.state.files).forEach( ([key, value]) => {
      this.getGroups(value)
    }));
  }
 
  getGroups(name) {
    get(`/api/v1/tests/groups?project=${this.props.project}&name=${name}`)
      .then(response => {
        this.setState(prevState => ({
          isLoaded: true,
          groups: {...prevState.groups, [name]: response.data},
        }));
      })
      .catch(error => {
        this.setState({ isLoaded: true, error });
      });
  }

  updateGroups = (newGroups, e) => {
    const { files, selectedTabId } = this.state;
    let name = files[selectedTabId]
    this.setState({ groups: {...this.state.groups, [name]: newGroups}, dirty: {...this.state.dirty, [name]: true}});
  };

  onSubmit = (name, e) => {
    e.preventDefault();
    const { groups } = this.state;
    this.setState(prevState => ({ 
      dirty: {...prevState.dirty, [name]: false},
      submitted: {...prevState.submitted, [name]: true},
      }));
    toaster.show({
      message: `The request was sent!`,
      intent: Intent.PRIMARY
    });
    post(`/api/v1/tests/groups?project=${this.props.project}&name=${name}`, {
      project: this.props.project,
      groups: groups[name],
    })
      .then(response => {
        this.setState(prevState => ({submitted: {...prevState.submitted, [name]: false}}));
        toaster.show({
          message: `...Acknowledged!`,
          intent: Intent.SUCCESS
        });
      })
      .catch(error => {
        this.setState(prevState => ({ submitted: {...prevState.submitted, [name]: false}, dirty: {...prevState.dirty, [name]: true}}));
        toaster.show({
          message: `Something wrong happened ${JSON.stringify(error.response)}`,
          intent: Intent.DANGER,
        });
      });
  };

  handleTabChange = (newTabId, prevTabId, e) => { this.setState({ selectedTabId: newTabId }) };

  editorDidMount(editor, monaco) {
  }
  
  editorWillMount(monaco) {
  }

  // TODO: add serach feature of other users yamls (read-only)
  // renderGroups = (group, { modifiers, handleClick }) => {
  //   // if (!modifiers.matchesPredicate)
  //   return null;
  //   return (
  //     <MenuItem
  //       // active={modifiers.active}
  //       // icon={this.isRoiGroupSelected(group) ? "tick" : "blank"}
  //       // key={group.title}
  //       // onClick={(handleClick)}
  //       // text={group.title}
  //       text={"dff"}
  //       shouldDismissPopover={false}
  //     />
  //   );
  // };
  // handleGroupsMultiSelect = (group) => {
  //   // if (!this.isuserGroupSelected(group))
  //   //   this.selectuserGroup(group);
  //   // else
  //   //   this.deselectuserGroup(this.getSelecteduserGroupIndex(group));
  // };

  render() {
    const { project, commit, config, git } = this.props;
    const { isLoaded, error, groups, selectedTabId, files, dirty, submitted} = this.state;

    if (!isLoaded) return <Spinner />;
    if (error)
      return (
        <NonIdealState
          title="An error occurred"
          description={JSON.stringify(error.response)}
        />
      );

    const user_form_name = files?.['usr'] || ''
    let group_name = files[selectedTabId]
    let group_value = groups[group_name]
    let is_group_dirty = dirty[group_name]
    let is_group_submitted = submitted[group_name]
    // let is_any_dirty = Object.values(dirty || []).some(v => v)
    // let is_any_submitted = Object.values(submitted || []).some(v => v)

    const panel_user = <>
      <MonacoEditor
        height={400}
        language='yaml'
        options={editor_options}
        name="user_groups"
        onChange={this.updateGroups}
        value={group_value || ""}
        // editorDidMount={this.editorDidMount}
        // editorWillMount={this.editorWillMount}
      />
    </>

    const panel_shared = <>
      <MonacoEditor
        height={400}
        language='yaml'
        options={editor_options}
        name="groups"
        onChange={this.updateGroups}
        value={group_value || ""}
        // editorDidMount={this.editorDidMount}
        // editorWillMount={this.editorWillMount}
      />
    </>

    let commit_groups_files = config.inputs?.batches ?? config.inputs?.groups ?? []; // .groups for backward compat
    if (!Array.isArray(commit_groups_files))
      commit_groups_files = [commit_groups_files]
    // we allow python-syntax formatting with project/subproject
    // ideally we should something more... complete
    let project_repo = git.path_with_namespace ?? '';
    let subproject = project.slice(project_repo.length + 1);
    commit_groups_files = commit_groups_files.map(f => {
      const subproject_parts = subproject.split('/')
      const project_parts = project.split('/')
      // FIXME: call utils.fill_template, with a twist to replace "\${key}" with ${key},
      //        but not trivial since those are to be interpreted as python Pathlib... 
      return f.replace('{project.name}', project_parts[project_parts.length-1])
              .replace('{subproject.parts[0]}', subproject_parts[0])
              .replace('{subproject}', subproject)
    })
    return (
       <form>
        <Callout title="How to define groups of tests" icon='info-sign' style={{marginBottom: '10px'}}>
          <p>Tuning runs can use the custom groups/batches below:
          <ol className={Classes.LIST}>
            <li>Use your private form <b>{user_form_name}</b> (has the highest precedence)</li>
            <li>or the <b>Collaborative</b> form, <em>which is shared with all the project users</em></li>
            <li>or the <b>default</b> forms:</li>
          <ul className={Classes.LIST}>
           {commit_groups_files.map(file => <React.Fragment key={file}>
             <li><a href={`${git?.web_url}/tree/${commit.id}/${file}`}>{file}</a></li>
            </React.Fragment>)}
          </ul></ol></p>
          <p><b>Tip:</b> The <a href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/defining-groups-of-tests`}>wiki</a> provides many examples to help get the syntax right.</p>
          <p>
            <em>Paths are relative to <code>{config.inputs?.database?.windows}</code> by default.</em>
            <CopyToClipboard
              text={config?.inputs?.database?.windows}
              style={{margin: '5px'}}
              onCopy={() => {
                toaster.show({
                  message: "Copied to clipboard!",
                  intent: Intent.PRIMARY
                });
              }}>
              <Tag interactive minimal round icon="duplicate">Copy</Tag>
            </CopyToClipboard>
          </p>
        </Callout>
        <div className={`${Classes.INLINE} ${Classes.FORM_GROUP}`}>
          <Button
            disabled={!is_group_dirty || is_group_submitted}
            intent={Intent.PRIMARY}
            onClick={(e)=>this.onSubmit(group_name, e)}
            style={{marginRight: '12px'}}
            icon="floppy-disk"
            >
          <span>Update list of custom groups</span>
          </Button>
          {/* <Button
            disabled={!is_any_dirty || is_any_submitted}
            intent={Intent.DANGER}
            onClick={(e)=>{Object.entries(files).forEach( ([key, value]) => {if(dirty[value]){this.onSubmit(value, e)}})}}
            icon={<><Icon icon="floppy-disk" style={{marginRight: '4px'}}/>
                    <Icon icon="floppy-disk" style={{marginRight: '4px'}}/></>}
            >
          <span>Update All</span>
          </Button> */}
        </div>

        <div className={`${Classes.INLINE} ${Classes.FORM_GROUP}`} />

        <Tabs renderActiveTabPanelOnly id="Groups" onChange={this.handleTabChange} defaultSelectedTabId="usr">
          <Tab id="gr" title="Collaborative" panel={panel_shared} />
          <Tab id="usr" title={user_form_name} panel={panel_user} />
          <Tabs.Expander />
          <Tooltip content="Coming Soon!">
            <MultiSelect
              placeholder="Search tests..."
              // itemRenderer={this.renderGroups}
              items={[]}
              // onItemSelect={this.handleGroupsMultiSelect}
              tagRenderer={() => {}}
            />
          </Tooltip>
        </Tabs>
      </form>
    );
  }
}


export { AddRecordingsForm };
