import React from "react";
import { Link } from "react-router-dom";
import { InView } from 'react-intersection-observer'
import { get, all, CancelToken } from "axios";
import { matchPath  } from 'react-router'
import pathToRegexp from 'path-to-regexp'

import styled from "styled-components";
import {
  Classes,
  Intent,
  Card,
  Tag,
  Slider,
  HTMLSelect,
  Tooltip,
  Toaster,
} from "@blueprintjs/core";

import { OutputViewer } from "./OutputViewer";
import { MetricsTags } from "../components/metrics";
import { OutputTags, ExtraParametersTags } from '../components/tags'

import { updateSelected } from "../actions/selected";

export const toaster = Toaster.create();

// ES2018.....
Object.fromEntries = arr => Object.assign({}, ...Array.from(arr, ([k, v]) => ({[k]: v}) ));


const SlimCard = styled(Card)`
  padding: 5px !important;
  overflow: "auto";
`;



const output_header_style = {
  fontSize: ".7rem",
  fontWeight: 500,
  lineHeight: 1.6,
  letterSpacing: "-1px",
};
const OutputHeader = React.memo( ({project, commit, output, warning, type, dispatch }) => {
    const input_over_time_url = `/${project}/time-travel/${commit.branch}?filter=${output.test_input_path}${type==='bit_accuracy' ? "&show_bit_accuracy=true" : ""}`
    const has_metadata = !!output.test_input_metadata && (Object.keys(output.test_input_metadata).length > 0)
    const has_label = has_metadata && !!output.test_input_metadata.label
    return <>
      <h5 className={Classes.HEADING} style={output_header_style} >
        <Tooltip hoverCloseDelay={500} disabled={!has_metadata}>
          <span>
            <Link
              to={input_over_time_url}
              onClick={() => dispatch(updateSelected(project, {branch: commit.branch}))}
              style={{color: 'inherit'}}
            >
              {has_label ? output.test_input_metadata.label : output.test_input_path}
            </Link>
            <OutputTags output={output} warning={warning}/>
          </span>
          <div>
            {has_metadata && <>
                {has_label && <>
                  <h4 className={Classes.HEADING}>Path</h4>
                  <p>{output.test_input_path}</p>
                </>}
                <h4 className={Classes.HEADING}>Metadata</h4>
                <p>{JSON.stringify(output.test_input_metadata, null, 2)}</p>
            </>
            }
          </div>
        </Tooltip>
      </h5>
      <p><ExtraParametersTags parameters={output.extra_parameters}/>
      </p>
      </>
  })


class OutputCard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      // we delay fetching the output manifest and rendering the viewers
      // until the card comes into view
      viewable: false || props.viewable,
      // the output manifest lists all files created by the run
      manifests: {},
      is_loaded: false,
      error: {},
      cancel_source: {
        new: CancelToken.source(),
        reference: CancelToken.source(),
      },
      options: {
      }
    }
  }

  componentWillUnmount() {
    ["new", "reference"].forEach(label => {
      if (!!this.state.cancel_source[label])
        this.state.cancel_source[label].cancel();      
    })
  }


  fetchData(props, label) {
    const { output_new, output_ref } = props;
    // console.log(output_new, output_ref)
    if (!output_new.output_dir_url) return;
    this.setState({is_loaded: false})

    let results = [];
    const should_get_all = (label === undefined || label === null);
    if (should_get_all || label === 'new') {
      results.push(['new', `${output_new.output_dir_url}/manifest.outputs.json`])
    }
    if (should_get_all || label === 'reference') {
      if (!!output_ref && !!output_ref.output_dir_url)
        results.push(['reference', `${output_ref.output_dir_url}/manifest.outputs.json`])
    }

    const load_data = label => (response, error) => {
      this.setState((previous_state, props) => ({
        manifests: {
          ...previous_state.manifests,
          [label]: response.data,
        },
        error: {
          ...previous_state.error,
          [label]: error,
        }
      }))
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: this.state.cancel_source.token})
                    .then(load_data(label))
                    .catch(response => {
                     load_data(label)(
                        {load_data  : {}},
                        response,
                      )
                    });
    }).map(f=>f()) )
    // now we loaded and parsed all the data
    .then( () => {
      this.updateOptions()
    })
  }


  becameViewable = inView => {
  	if (!inView)
  		return
  	this.setState(
  		{
  		  viewable: true,
  		},
  		() => this.fetchData(this.props)
  	)
  }
 

  componentDidUpdate(prevProps, prevState) {
  	  if (!this.state.viewable)
  	  	return;
      const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
      const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
      let updated_new = has_new && (prevProps.output_new === null || prevProps.output_new === undefined || prevProps.output_new.id !== this.props.output_new.id);
      let updated_ref = has_ref && (prevProps.output_ref === null || prevProps.output_ref === undefined || prevProps.output_ref.id !== this.props.output_ref.id);
      if (updated_new) {
        if (!!this.state.cancel_source.new)
          this.state.cancel_source.new.cancel();
        this.fetchData(this.props, 'new');
      }
      if (updated_ref) {
        if (!!this.state.cancel_source.reference)
          this.state.cancel_source.reference.cancel();
        this.fetchData(this.props, 'reference');
      }
  }

  setSelectedOption = name => e => {
    const selected = !!e.target ? e.target.value : e;
    this.setState({
      options: {
        ...this.state.options,
        [name]: {
          ...this.state.options[name],
          selected: [selected], 
        }
      }
    })
  }



  updateOptions() {
    if (this.state.manifests.new === undefined || this.state.manifests.new === null) {
      this.setState({
        is_loaded: true,
      })
      return;
    }

    const outputs = (((this.props.project_data || {}).data || {}).qatools_config || {}).outputs || {}
    const views = [...(outputs.visualizations || []), ...(outputs.detailed_views || []) ]; // we allow both for some leeway with half updated projects
    // console.log(views)
    var options = {}
    views.forEach((view, idx) => {
      if (view.path === undefined) return
      // be glob-friendly
      // FIXME: also get the extension, that's the common case...
      // let path_regex = view.path.replace(/[^\.]\*/g, '(.*)')
      let view_options = pathToRegexp.parse(view.path)
      view_options.forEach(token => {
        if (token.name === undefined) // static part
          return
        if (Number.isInteger(token.name)) {
          // we must not confuse unnamed group
          token.unnamed_group = token.name
          token.name = `${idx}-${token.name}`
        }
        if (options[token.name] === undefined)
          options[token.name] = {views: []}
        options[token.name] = {...options[token.name], ...token}
        options[token.name].views.push(view.name)
        options[token.name].path = view.path
      })
    })

    const paths = Object.keys(this.state.manifests.new)
    Object.entries(options).forEach( ([name, option]) => {
      option.values = new Set()
      paths.forEach(path => {
        // const match = option.match.exec(p);
        const match = matchPath(path, {path: option.path}) // they do their own caching
        if (match === null || match === undefined) return;
        let name_ = option.unnamed_group !== undefined ? option.unnamed_group : name;
        option.values.add(match.params[name_])
      })
      option.values = Array.from(option.values.values())
      const all_is_integer = option.values.length > 0 && option.values.every(v => Number.isInteger(parseFloat(v)) )
      if (all_is_integer) {
        option.type = 'slider'
        option.to_raw = {}
        option.min =  Infinity
        option.max = -Infinity
        option.values.forEach(v => {
          const v_num = parseFloat(v);
          if (v_num < option.min) option.min = v_num;
          if (v_num > option.max) option.max = v_num;
          option.to_raw[v_num] = v
        })
        option.selected = [option.max]
      } else {
        option.selected = [option.values[0]]
      }
    })
    this.setState({
      options,
      is_loaded: true,
    })
  }
 

  render() {
    const { is_loaded, error } = this.state;
    const { output_new, output_ref, warning } = this.props;

    const has_output_new = output_new !== undefined && output_new !== null
    if (!has_output_new || output_new.is_pending)
      return <span/>

    const qatools_config = (((this.props.project_data || {}).data || {}) || {}).qatools_config;
    const style = {
      ...((qatools_config.outputs || {}).style || {}),
      ...this.props.style,
    }


    var content;
    if (!is_loaded && !has_output_new) {
      content = <span/>;
    } else {
      const { main_metrics, available_metrics } = ((this.props.project_data || {}).data || {}).qatools_metrics || {};
      var controls = this.props.controls || {};

	    // layout should be plotly-like. You could also pass down a props named style.
      var views = [...((qatools_config.outputs || {}).visualizations || []), ...((qatools_config.outputs || {}).detailed_views || []) ]; // we allow both for some leeway with half updated projects

	    let viewers = views.map( (view, idx) => {
	      let hidden = view.default_hidden===true && !(!!controls.show && controls.show[view.name]===true)
	      if (hidden)	
	        return <span key={idx}/>

	      const view_options = Object.values(this.state.options).filter(option => option.views.includes(view.name))
	      if (view_options.some(o => o.selected[0] === undefined || o.selected[0] === null))
	        return <span key={idx} />

	      if (!(view.display === 'viewer') && view_options.length > 0 ) {
	        if (view.display === undefined || view.display === 'single') {
	          const view_options_selected = view_options.map(o => [o.unnamed_group !==undefined ? o.unnamed_group : o.name, o.to_raw ? o.to_raw[o.selected[0]] : o.selected[0]])
	          var paths = [compilePath(view.path)(Object.fromEntries(view_options_selected))]
	        } else if (view.display === 'all') {
	          paths = Object.keys(this.state.manifests.new).filter(path => matchPath(path, {path: view.path}))
	        }
	      } else {
          let necessary_files_exist = view.path===undefined || (!!this.state.manifests.new && !!this.state.manifests.new[view.path]) || view.path === 'pointcloud.pcd';
	        paths = necessary_files_exist ? [view.path] : []
	      }
	      // console.log(view.display, paths)

	      return paths.map(
	        (path, path_idx) => <div key={`${idx}-${path_idx}`} id={`${idx}-${path_idx}`}>
	          {paths.length > 1 && <h3 style={{marginBottom: '0px'}}>{path}</h3>}
	          <OutputViewer
	            key={`${idx}-${path_idx}`}
	            id={`${idx}-${path_idx}`}
	            output_new={output_new}
	            output_ref={(controls.show_reference === undefined || controls.show_reference) ? output_ref : undefined}
	            manifests={this.state.manifests}
	            {...view}
	            path={path}
	            {...controls}
	            style={{...style, ...view.style}}
	          />
	        </div>
	      )
	    })

      if (this.props.type === 'bit_accuracy') {
	      content = <OutputViewer
		       key="bit-accuracy"
		       type="files/bit-accuracy"
		       {...controls}
		       controls={controls}
		       output_new={output_new}
		       output_ref={output_ref}
		       manifests={this.state.manifests}
		       style={style}
		       show_all_files={this.props.show_all_files}
		       expand_all={this.props.expand_all}
		       files_filter={this.props.files_filter}
		      />
      } else {
      	content = <>
          {!output_new.is_failed && <MetricsTags
            selected_metrics={main_metrics}
            available_metrics={available_metrics}
            metrics_new={output_new.metrics ? output_new.metrics : {}}
            metrics_ref={output_ref && output_ref.metrics ? output_ref.metrics : {}}
          />}
         {viewers}
        </>
      }
    }


  	// https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
  	// https://www.npmjs.com/package/react-intersection-observer

    let container_style = {
      flex: "0 0 auto",
      width: style.width || '400px',
      marginBottom: "20px"
    }
    return <div style={container_style}>
      <SlimCard className="output-card">
          {error.new && <Tooltip key="error-new"><Tag style={{margin: '5px'}} intent={Intent.DANGER}>Download error @new</Tag><span dangerouslySetInnerHTML={{__html: !!error.new.response ? error.new.response.data : error.new}}/></Tooltip>}
          {error.reference && <Tooltip key="error-ref"><Tag style={{margin: '5px'}} intent={Intent.DANGER}>Download error @reference</Tag><span dangerouslySetInnerHTML={{__html: !!error.reference.response ? error.reference.response.data : error.reference}}/></Tooltip>}

          {!this.props.no_header && <OutputHeader project={this.props.project} commit={this.props.commit} output={output_new} warning={warning} type={this.props.type} dispatch={this.props.dispatch}/>}

          {output_new.is_failed && <Tag intent={Intent.DANGER}>Failed</Tag>}
          {output_ref && output_ref.is_failed && <Tag intent={Intent.WARNING}>Reference Failed</Tag>}
          {output_new.deleted && <Tag intent={Intent.DANGER}>Deleted</Tag>}
          {output_ref && output_ref.deleted && <Tag intent={Intent.WARNING}>Reference deleted</Tag>}

          {is_loaded && this.props.type !== 'bit_accuracy' && !!this.state.options && Object.entries(this.state.options).map( ([name, option]) => { // FIXME: need to filter, only care about shown viewers...
            const option_label = isNaN(option.name) ? option.name : option.pattern
            if (option.views.every(name => views.find(v => v.name === name).default_hidden===true && !(!!controls.show && controls.show[name]===true)) )
              return <span key={option.name}/>
            if (option.type === 'slider') {
              // let labelStepSize = (option.max - option.min) / 10
              let labelStepSize = Math.pow(10, Math.floor(Math.log10(option.max - option.min)))
              return <div key={option_label} title={option_label} style={{marginLeft: '5px', marginRight: '5px', paddingLeft: '5px', paddingRight: '5px'}}>
                <Slider initialValue={option.selected[0]} value={option.selected[0]} min={option.min} max={option.max} labelStepSize={labelStepSize} onChange={this.setSelectedOption(option.name)} showTrackFill/>
              </div>
            } else {
              return <div key={option_label} title={option_label}>{option.values.length>0 && <HTMLSelect options={option.values} value={option.selected[0]} onChange={this.setSelectedOption(option.name)}/>}</div>
            }
          })}

        	{!this.state.viewable && <InView threshold={0.1} margin='150%' /*triggerOnce*/ onChange={inView => this.becameViewable(inView)}>
    	      <span></span>
    	    </InView>}
          {(is_loaded || has_output_new) && content}
      </SlimCard>
    </div>
  }
}



// Adapted from
// https://github.com/ReactTraining/react-router/blob/82ce94c3b4e74f71018d104df6dc999801fa9ab2/packages/react-router/modules/matchPath.js
const cache = {};
const cacheLimit = 10000;
let cacheCount = 0;
function compilePath(path) {
  if (cache[path]) return cache[path];
  const regexp = pathToRegexp.compile(path);
  if (cacheCount < cacheLimit) {
    cache[path] = regexp;
    cacheCount++;
  }
  return regexp;
}


export { OutputCard };
