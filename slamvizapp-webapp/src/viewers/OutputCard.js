import React, { Component, lazy, Suspense } from "react";
import { get, all, CancelToken } from "axios";
import { matchPath  } from 'react-router'
import pathToRegexp from 'path-to-regexp'

import styled from "styled-components";
import { CopyToClipboard } from "react-copy-to-clipboard";
import {
  Classes,
  Intent,
  Card,
  Tag,
  Icon,
  Slider,
  HTMLSelect,
  Popover,
  Tooltip,
  Toaster,
} from "@blueprintjs/core";

import { MetricsTags } from "../components/metrics";
import { PlatformTag, ConfigurationsTags, ExtraParametersTags } from '../components/tags'
import { linux_to_windows } from '../utils'

export const toaster = Toaster.create();


// ES2018.....
Object.fromEntries = arr => Object.assign({}, ...Array.from(arr, ([k, v]) => ({[k]: v}) ));


const SlimCard = styled(Card)`
  padding: 5px !important;
  overflow: "auto";
`;



class OutputHeader extends React.PureComponent {
  render() {
    const { output, warning } = this.props;
    const style = {
      fontSize: ".7rem",
      fontWeight: 500,
      lineHeight: 1.6,
      letterSpacing: "-1px",
    }
    return <>
      <h5 className={Classes.HEADING} style={style} >
        <a style={{color: 'inherit'}} href={`/${this.props.project}/dashboard/${this.props.commit.branch.replace('origin/', '')}?breakdown_per_test=true&filter=${output.test_input_path}`}>{output.test_input_path}</a> <OutputTags output={output} warning={warning}/>
      </h5>
      <p><ExtraParametersTags parameters={output.extra_parameters}/>
      </p>
      </>
  }
}


class OutputTags extends React.PureComponent {
  render() {
    const { platform, configuration, output_dir_url } = this.props.output;
    const { warning } = this.props;
    let windows_path = linux_to_windows(output_dir_url);
    return <span>
      <PlatformTag platform={platform}/>
      <ConfigurationsTags configuration={configuration} />
      <Tooltip>
        <a
          style={{ marginLeft: "4px" }}
          target="_blank"
          rel="noopener noreferrer"
          href={output_dir_url}
        >
          <Icon icon="folder-shared-open" style={{verticalAlign: 'baseline'}}/>
        </a>
        <span>Open the output directory</span>
      </Tooltip>
    <Tooltip>
        <CopyToClipboard
          text={windows_path}
          onCopy={() => {
            toaster.show({
              message: "Copied the output directory's windows-path to clipboard!",
              intent: Intent.PRIMARY
            });
          }}
        >
          <Icon
            title="copy to clipboard"
            intent={Intent.PRIMARY}
            iconSize={Icon.SIZE_SMALL}
            icon="duplicate"
            style={{ marginLeft: "4px" }}
          />
        </CopyToClipboard>
        <span>Copy to the clipboard the Windows directory </span>
      </Tooltip>

      {warning && (
        <Popover interactionKind="hover">
          <Icon intent={Intent.WARNING} icon="warning-sign" style={{verticalAlign: 'baseline'}} />
          <span>{warning}</span>
        </Popover>
      )}
    </span>
  }
}



const LoadableSlamViewer = lazy(() => import('./slam/SlamOutputCard' /* webpackChunkName: "slam-viewer" */));
const LoadableTofViewer = lazy(() => import('./tof/TofOutputCard' /* webpackChunkName: "tof-viewer" */));
const LoadablePlotlyViewer = lazy(() => import('./plotly' /* webpackChunkName: "plotly-viewer" */));
const LoadableVideoViewer = lazy(() => import('./videos' /* webpackChunkName: "video-viewer" */));
const LoadableImageViewer = lazy(() => import('./images/images' /* webpackChunkName: "image-viewer" */));
const LoadableTextViewer = lazy(() => import('./textViewer' /* webpackChunkName: "text-viewer" */));
const LoadableHtmlViewer = lazy(() => import('./html' /* webpackChunkName: "html-viewer" */));
const LoadableBitAccuracyViewer = lazy(() => import('./bit_accuracy/bitAccuracyViewer' /* webpackChunkName: "bit-accuracy-viewer" */));

class OutputViewer extends React.Component {
  render() {
    const { type, output_ref, ...props } = this.props;
    const maybe_output_ref = (this.props.show_reference === undefined || this.props.show_reference) ? output_ref : undefined;
    let viewer;
    if (!!type) {
      if (type === "6dof/txt")
        viewer =  <LoadableSlamViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === "pointcloud/txt")
        viewer = <LoadableTofViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === "plotly/json")
        viewer = <LoadablePlotlyViewer {...props} output_ref={maybe_output_ref}/>
      else if (type.startsWith('video'))
        viewer = <LoadableVideoViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type.startsWith('image'))
        viewer = <LoadableImageViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type === 'text/plain')
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
      else if (type === 'text/html')
        viewer = <LoadableHtmlViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type === 'files/bit-accuracy')
        viewer = <LoadableBitAccuracyViewer {...props} type={type} output_ref={output_ref}/>
      else viewer = <span>No viewer is defined for type: {type}</span>;
    } else {
      const { path } = this.props;
      if (path.endsWith('png') ||
          path.endsWith('jpg') ||
          path.endsWith('jpeg')||
          path.endsWith('bmp') ||
          path.endsWith('pdf') ||
          path.endsWith('tif') ||
          path.endsWith('tiff')||
          path.endsWith('dng') ||
          path.endsWith('raw') ||
          path.endsWith('hex')) {
        viewer = <LoadableImageViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else if (path.endsWith('plotly.json')) {
        viewer = <LoadablePlotlyViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else {
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
      }
    }
  return (
    <Suspense fallback={<span/>}>
      {viewer}
    </Suspense>
  );
  }
}


class OutputCard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      cancel_source: {
        new: CancelToken.source(),
        reference: CancelToken.source(),
      },
      is_loaded: false,
      error: {},
      manifests: {},
      options: {
      }
    }
  }

  componentDidMount() {
    this.fetchData(this.props);
  }

  componentWillUnmount() {
    ["new", "reference"].forEach(label => {
      if (!!this.state.cancel_source[label])
        this.state.cancel_source[label].cancel();      
    })
  }


  fetchData(props, label) {
    const { output_new, output_ref } = props;
    if (!output_new.output_dir_url) return;
    this.setState({is_loaded: false})

    let results = [];
    const should_get_all = label === undefined || label === null;
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
      // this.setState({
      //   is_loaded: true,
      // })
    })
  }


  componentDidUpdate(prevProps, prevState) {
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
    if (this.state.manifests.new === undefined || this.state.manifests.new === null)
      return;

    const outputs = (((this.props.project_data || {}).data || {}).qatools_config || {}).outputs || {}
    const views = outputs.visualizations || outputs.detailed_views || [];
    // console.log(views)
    var options = {}
    views.forEach(view => {
      // be glob-friendly
      // FIXME: also get the extension, that's the common case...
      // let path_regex = view.path.replace(/[^\.]\*/g, '(.*)')
      let view_options = pathToRegexp.parse(view.path)
      view_options.forEach(token => {
        if (token.name === undefined) // static part
          return
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
        option.values.add(match.params[name])
      })
      option.values = Array.from(option.values.values())
      // console.log(name, option.values)
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
    const { main_metrics, available_metrics } = ((this.props.project_data || {}).data || {}).qatools_metrics || {};
    const { output_new, output_ref, warning } = this.props;
    const { qatools_config } = this.props.project_data.data;
    const controls = this.props.controls || {};

    if (output_new === undefined  || output_new === null || output_new.is_pending)
      return <span/>
    if (!is_loaded) return <span></span>;

    // layout should be plotly-like. You could also pass down a props named style.
    const views = qatools_config.outputs.visualizations || qatools_config.outputs.detailed_views || [];
    const style = {
      ...qatools_config.outputs.style,
      ...this.props.style,
    }

    let viewers = views.map( (view, idx) => {
      let hidden = view.default_hidden===true && !(!!controls.show && controls.show[view.name]===true)
      if (hidden)
        return <span key={idx}/>

      const view_options = Object.values(this.state.options).filter(option => option.views.includes(view.name))
      if (view_options.some(o => o.selected[0] === undefined || o.selected[0] === null))
        return <span key={idx} />

      if (!(view.display === 'viewer') && view_options.length > 0 ) {
        if (view.display === undefined || view.display === 'single') {
          const view_options_selected = view_options.map(o => [o.name, o.to_raw ? o.to_raw[o.selected[0]] : o.selected[0]])
          var paths = [compilePath(view.path)(Object.fromEntries(view_options_selected))]
        } else if (view.display === 'all') {
          paths = Object.keys(this.state.manifests.new).filter(path => matchPath(path, {path: view.path}))
        }
      } else {
        paths = [view.path]
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

    let container_style = {
      flex: "0 0 auto",
      width: style.width || '400px',
      marginBottom: "20px"
    }
    return <div style={container_style}>
      <SlimCard className="output-card">
          {error.new && <Tooltip key="error-new"><Tag style={{margin: '5px'}} intent={Intent.DANGER}>Download error @new</Tag><span dangerouslySetInnerHTML={{__html: !!error.new.response ? error.new.response.data : error.new}}/></Tooltip>}
          {error.reference && <Tooltip key="error-ref"><Tag style={{margin: '5px'}} intent={Intent.DANGER}>Download error @reference</Tag><span dangerouslySetInnerHTML={{__html: !!error.reference.response ? error.reference.response.data : error.reference}}/></Tooltip>}

          {!this.props.no_header && <OutputHeader project={this.props.project} commit={this.props.commit} output={output_new} warning={warning}/>}

          {output_new.is_failed && <Tag intent={Intent.DANGER}>Failed</Tag>}
          {output_ref && output_ref.is_failed && <Tag intent={Intent.WARNING}>Reference Failed</Tag>}

          {this.props.type !== 'bit_accuracy' && !!this.state.options && Object.entries(this.state.options).map( ([name, option]) => { // FIXME: need to filter, only care about shown viewers...
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
              return <div key={option_label} title={option_label}><HTMLSelect options={option.values} value={option.selected[0]} onChange={this.setSelectedOption(option.name)}/></div>
            }
          })}

          {this.props.type === 'bit_accuracy'
            ? <OutputViewer
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
            : <>
              {!output_new.is_failed && <MetricsTags
                selected_metrics={main_metrics}
                available_metrics={available_metrics}
                metrics_new={output_new.metrics ? output_new.metrics : {}}
                metrics_ref={output_ref && output_ref.metrics ? output_ref.metrics : {}}
              />}
              {viewers}
            </>
          }
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


export { OutputCard, OutputViewer };
