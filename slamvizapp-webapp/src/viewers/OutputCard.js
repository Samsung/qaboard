import React, { Component, lazy, Suspense } from "react";

import styled from "styled-components";
import { Card, Icon, Intent, Tag, Classes, Popover, Toaster, Tooltip } from "@blueprintjs/core";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { MetricTag } from "../components/metrics";


export const toaster = Toaster.create();

const SlimCard = styled(Card)`
  padding: 5px !important;
  overflow: "auto";
`;




class MetricsTags extends React.PureComponent {
  render() {
    const { metrics_new, metrics_ref } = this.props;
    const { available_metrics, selected_metrics } = this.props;
    return selected_metrics
      .filter(key => metrics_new[key] !== undefined)
      .map(key => (
        <p key={key}>
          <MetricTag
            metrics_new={metrics_new}
            metrics_ref={metrics_ref}
            metric_info={available_metrics[key]}
          />
        </p>
      ))
  }
}


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
        {output.test_input_path} <OutputTags output={output} warning={warning}/>
      </h5>
      <p>{Object.entries(output.extra_parameters).map(([k, v]) => (
        <Tag key={k} round minimal style={{margin: '3px'}}>
          {k}:{JSON.stringify(v)}
        </Tag>
      ))}
      </p>
      </>
  }
}


class OutputTags extends React.PureComponent {
  render() {
    const { platform, configuration, output_dir_url } = this.props.output;
    const { warning } = this.props;
    let windows_path = output_dir_url
                         .replace('/s', '')
                         .replace('//home', '//mars/raid/users')
                         .replace('/home', '//mars/raid/users')
                         .replace('//stage', '//netapp2')
                         .replace('/stage', '//netapp2')
    // if (!windows_path.startsWith('//mars') || !windows_path.startsWith('//netapp'))
    //   windows_path = `//mars/raid/users/arthurf${windows_path}` 
    windows_path = windows_path.replace(/\//g, '\\')
    return <span>
      <Tag intent={Intent.PRIMARY} round minimal>{platform}</Tag>
      <Tag intent={Intent.PRIMARY} round minimal>{configuration}</Tag>
      <a
        title="Show output files"
        style={{ marginLeft: "4px" }}
        target="_blank"
        rel="noopener noreferrer"
        href={output_dir_url}
      >
        <Icon icon="folder-shared-open" style={{verticalAlign: 'baseline'}}/>
      </a>
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
        <span>Copy to clipboard</span>
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
const LoadableCisViewer = lazy(() => import('./cis/CisOutputCard' /* webpackChunkName: "cis-viewer" */));
const LoadablePlotlyViewer = lazy(() => import('./plotly' /* webpackChunkName: "plotly-viewer" */));
const LoadableVideoViewer = lazy(() => import('./videos' /* webpackChunkName: "video-viewer" */));
const LoadableImageViewer = lazy(() => import('./images' /* webpackChunkName: "image-viewer" */));
const LoadableTextViewer = lazy(() => import('./textViewer' /* webpackChunkName: "text-viewer" */));
const LoadableHtmlViewer = lazy(() => import('./html' /* webpackChunkName: "html-viewer" */));
const LoadableBitAccuracyViewer = lazy(() => import('./bit_accuracy/bitAccuracyViewer' /* webpackChunkName: "bit-accuracy-viewer" */));

class OutputViewer extends React.Component {
  render() {
    const { type, ...props } = this.props;
    let viewer;
    if (!!type) {
      if (type === "6dof/txt")
        viewer =  <LoadableSlamViewer {...props}/>
      else if (type === "pointcloud/txt")
        viewer = <LoadableTofViewer {...props} />
      else if (type === "cis/image")
        viewer = <LoadableCisViewer {...props} />
      else if (type === "plotly/json")
        viewer = <LoadablePlotlyViewer {...props} />
      else if (type.startsWith('video'))
        viewer = <LoadableVideoViewer {...props} type={type} />
      else if (type.startsWith('image'))
        viewer = <LoadableImageViewer {...props} type={type} />
      else if (type === 'text/plain')
        viewer = <LoadableTextViewer {...props} type={type} />
      else if (type === 'text/html')
        viewer = <LoadableHtmlViewer {...props} type={type} />
      else if (type === 'files/bit-accuracy')
        viewer = <LoadableBitAccuracyViewer {...props} type={type} />
      else viewer = <span>No viewer is defined for type: {type}</span>;
    } else {
      const { path } = this.props;
      if (path.endsWith('png') || path.endsWith('jpg')) {
        viewer = <LoadableImageViewer {...props} type={type} />
      } else if (path.endsWith('hex') || path.endsWith('raw')) {
        viewer = <LoadablePlotlyViewer {...props} type={type}/>
      } else if (path.endsWith('plotly.json')) {
        viewer = <span>No viewer is registered yet for {path}.</span>;
      } else {
        viewer = <LoadableTextViewer {...props} type={type} />
      }
    }
  return (
    <Suspense fallback={<div>Loading...</div>}>
      {viewer}
    </Suspense>
  );
  }
}



class OutputCard extends Component {
  render() {
    const { main_metrics, available_metrics } = this.props.project_data.information.qatools_metrics;
    const { output_new, output_ref, warning } = this.props;
    const { qatools_config } = this.props.project_data.information;
    const controls = this.props.controls || {};

    // layout should be plotly-like. You could also pass down a props named style.
    if (!output_new || output_new.is_pending)
      return <span/>
    if (output_new.is_failed && !(this.props.type === 'bit_accuracy'))
      return <span/>

    const views = qatools_config.outputs.detailed_views || [];
    const style = {
      ...qatools_config.outputs.style,
      ...this.props.style,
    }

    let viewers = views.map( (view, idx) => {
        let hidden = view.default_hidden===true && !(!!controls.show && controls.show[view.name]===true)
        if (hidden)
          return <span key={idx}/>

        return <OutputViewer
          key={idx}
          output_new={output_new}
          output_ref={(controls.show_reference === undefined || controls.show_reference) ? output_ref : undefined}
          {...view}
          {...controls}
          style={style}
        />

    })

    let container_style = {
      flex: "0 0 auto",
      width: style.width || '400px',
      marginBottom: "20px"
    }
    return <div style={container_style}>
      <SlimCard className="output-card">
          {!this.props.no_header && <OutputHeader output={output_new} warning={warning}/>}
          {this.props.type === 'bit_accuracy'
            ? <OutputViewer
               key="bit-accuracy"
               type="files/bit-accuracy"
               {...controls}
               controls={controls}
               output_new={output_new}
               output_ref={output_ref}
               style={style}
               show_all_files={this.props.show_all_files}
              />
            : <>
              <MetricsTags
                selected_metrics={main_metrics}
                available_metrics={available_metrics}
                metrics_new={output_new.metrics ? output_new.metrics : {}}
                metrics_ref={output_ref && output_ref.metrics ? output_ref.metrics : {}}
              />
              {viewers}
            </>
          }
      </SlimCard>
    </div>
  }
}


          // <OutputViewer key="test" type="text/plain" output_new={output_new} output_ref={output_ref} style={style} path='metrics.json'/>


export { OutputCard, OutputViewer };
