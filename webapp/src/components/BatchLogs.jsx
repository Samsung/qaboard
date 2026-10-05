import React from "react";
import { InView } from 'react-intersection-observer'
import axios from "axios";
const { get } = axios;

import { DateTime } from 'luxon';
import sanitizeHtml from 'sanitize-html';

import {
  Classes,
  Collapse,
  Callout,
  AnchorButton,
  Button,
  ButtonGroup,
  NonIdealState,
  Tag,
} from "@blueprintjs/core";

import { StatusTag, style_skeleton } from './tags'
import { OutputHeader } from '../viewers/OutputCard'
import { pretty_label } from '../utils'
import { LsfReport, LsfTag } from './LsfReport'
import { fetchLsfReport } from './lsf'

import Convert from 'ansi-to-html';
var convert = new Convert();



// Escapes HTML, and renders ANSI colors
const logToHtml = logs => {
  logs = logs.replaceAll("<?", "??") // avoid issues wih tqdm prints being stripped
  // https://github.com/rburns/ansi-to-html/blob/master/src/ansi_to_html.js
  const logs_safe = sanitizeHtml(logs, { disallowedTagsMode: "recursiveEscape" });
  try {
    return convert.toHtml(logs_safe);
  } catch {
    return logs_safe;
  }
}


// log.txt is written by `qa run`.
// With LSF, log.lsf.txt has all the job's output, and LSF's job report (exit reason, resources...)
const LOG_FILES = ["log.txt", "log.lsf.txt"]


class OutputLog extends React.Component {
  constructor(props) {
    super(props);
    this.log_ref = null
    this.onRefChange = element => {
      this.log_ref = element
    };

    this.state = {
      is_loaded: false,
      is_open: false,
      error: null,
      logs_html_safe: null,
      log_file: LOG_FILES[0],
      lsf_report: null,
      lsf_report_requested: false,
      viewable: !!props.viewable,
    };
  }

  componentDidMount() {
    if (this.state.viewable && this.props.output?.is_failed)
      this.getLsfReport()
  }

  becameViewable = inView => {
    if (!inView) return
    this.setState({viewable: true})
    // We show right away why LSF killed failed runs
    if (this.props.output?.is_failed)
      this.getLsfReport()
  }

  componentDidUpdate(prevProps) {
    const { output } = this.props
    if (!output?.output_dir_url || !prevProps.output) return
    if (output.output_dir_url !== prevProps.output.output_dir_url) {
      this.setState({lsf_report: null, lsf_report_requested: false})
      if (this.state.is_open)
        this.getLog()
      return
    }
    // The run just finished
    if (prevProps.output.is_pending && !output.is_pending && (this.state.is_open || (this.state.viewable && output.is_failed)))
      this.getLsfReport(true)
  }

  refreshLog = () => {
    if ((!!this.props.output && !this.props.output.is_pending) || !this.state.is_open) {
      clearInterval(this.refreshLogInterval);
    } else {
      this.getLog();
    }
  }

  handleClick = () => {
    if (!this.state.is_loaded) this.getLog();
    this.getLsfReport();
    this.setState({ is_open: !this.state.is_open });

    if (!!this.refreshLogInterval) clearInterval(this.refreshLogInterval);
    if (!!this.props.output && this.props.output.is_pending) {
      this.refreshLogInterval = setInterval(this.refreshLog, 2500);
    }
  };

  showLogFile = log_file => {
    this.setState({ log_file, is_open: true })
    this.getLog(log_file)
  }

  componentWillUnmount(){
    if (!!this.refreshLogInterval) clearInterval(this.refreshLogInterval);
  }

  getLsfReport(force = false) {
    const { output } = this.props;
    if (!output?.output_dir_url || output.is_pending) return
    if (this.state.lsf_report_requested && !force) return
    this.setState({lsf_report_requested: true})
    const output_dir_url = output.output_dir_url
    fetchLsfReport(get, `${output_dir_url}/log.lsf.txt`)
      .then(lsf_report => {
        if (this.props.output?.output_dir_url === output_dir_url)
          this.setState({lsf_report})
      })
      .catch(() => {}) // e.g. not run with LSF
  }

  getLog(log_file) {
    const { output } = this.props;
    if (!!!output || !!!output.output_dir_url) return
    log_file = log_file ?? this.state.log_file
    this.setState({is_loaded: false});
    const log_url = `${output.output_dir_url}/${log_file}`
    get(log_url, { responseType: 'text', transformResponse: [data => data] })
      .then(response => {
        // the user may have switched to another file
        if (log_file !== this.state.log_file) return
        const logs = response.data;
        this.setState({
          is_loaded: true,
          logs_html_safe: !!logs ? logToHtml(logs) : logs,
          log_url,
          error: null,
        });
      })
      .catch(error => {
        if (log_file !== this.state.log_file) return
        console.log(error)
        this.setState({ log_url, is_loaded: true, error });
      });
  }

  scrollBottom = () => {
    if (this.log_ref) {
      this.log_ref.scrollTo(0, this.log_ref.scrollHeight)
    }
  }

  render() {
    const { output, commit, project, dispatch } = this.props;
    const { is_open, is_loaded, error, logs_html_safe, viewable, log_file, log_url, lsf_report } = this.state;

    const button_text = is_open ? "Hide" : is_loaded ? "Loading" : "Show";
    const show_button = (
      <Button title={button_text} onClick={this.handleClick}>
        {button_text} logs
      </Button>
    );
    const header_prefix = <>
      {show_button}{button_text==="Hide" && <Button onClick={this.scrollBottom} icon="double-chevron-down"></Button>} {output.output_type !== "batch" && <StatusTag output={output}/>}
      <LsfTag report={lsf_report} onClick={() => !is_open && this.handleClick()} />
    </>
    // Without LSF's report (e.g. runs from before 2026-10), we look at how the run ended
    const was_aborted = !lsf_report && output.is_failed && log_file === "log.txt" && (logs_html_safe ?? "").slice(-1000).includes("Aborted!")
    return (
      <div>
        {!viewable && <InView key="unviewable" threshold={0.1} margin='150%' /*triggerOnce*/ onChange={this.becameViewable}>
          <span key="viewable"></span>
        </InView>}
        <OutputHeader
          project={project}
          commit={commit}
          output={output}
          mismatch={output.reference_mismatch}
          dispatch={dispatch}
          prefix={header_prefix}
          tags_first
          viewable={viewable}
        />
        <Collapse isOpen={is_open}>
          <LsfReport report={lsf_report} />
          <div style={{ marginBottom: '5px' }}>
            <ButtonGroup>
              {LOG_FILES.map(name => <Button key={name} size="small" active={log_file === name} onClick={() => this.showLogFile(name)}>{name}</Button>)}
            </ButtonGroup>
            {!!log_url && <AnchorButton size="small" variant="minimal" icon="share" href={log_url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: '5px' }}>Open</AnchorButton>}
            {was_aborted && <Tag interactive intent="danger" onClick={() => this.showLogFile("log.lsf.txt")} style={{ marginLeft: '5px' }}>
              Aborted! Check log.lsf.txt to know why
            </Tag>}
          </div>
          {error ?
            <NonIdealState
              title={`No ${log_file}.`}
              description={
                error.response ? (error.response.status === 404 || (!!error.response.data && `${error.response.data}`.includes('404')) ? '404: Not found' : JSON.stringify(error.response.data)) : `${error}`
              }
            />
          : <pre
                ref={this.onRefChange}
                className={Classes.CODE_BLOCK}
                dangerouslySetInnerHTML={{
                  __html: logs_html_safe ?? ""
                }}
                style={{
                  maxHeight: '500px',
                  maxWidth: '1400px',
                  overflow: 'scroll',
                  ...(output.is_pending ? style_skeleton : {}),
                }}
              />
          }
        </Collapse>
      </div>
    );
  }
}




class BatchLogs extends React.Component {
  render() {
    const { batch } = this.props;
    if (batch === null || batch === undefined  || batch.batch_dir_url === undefined)
      return <span></span>

    let batch_mock_output = {
      is_failed: false,
      is_pending: false,
      is_running: false,
      extra_parameters: {},
      output_type: "batch",
      output_dir_url: batch.batch_dir_url,
      test_input_metadata: batch.data,
      configurations: [],
    }

    let commands = Object.values(batch.data?.commands ?? {});
    const some_tuning_commands = batch.data?.optimization ?? commands.some(c => !c.job_url)

    const title = pretty_label(batch)
    return <>
      {batch.filtered.outputs.map(id => batch.outputs[id])
            .filter( o => o.output_type !== "optim_iteration")
            .map(output => <OutputLog
              key={output.id}
              project={this.props.project}
              commit={this.props.commit}
              output={output}
              dispatch={this.props.dispatch}
            />)}
      <h2 style={{marginTop: '25px'}} className={Classes.HEADING}>Batch logs: {title}</h2>
      {some_tuning_commands && <OutputLog
        key={batch.batch_dir_url}
        project={this.props.project}
        commit={this.props.commit}
        output={batch_mock_output}
        dispatch={this.props.dispatch}
      />}
      <div>{commands.map( (command, id) => {
        return <Callout style={{marginBottom: '5px'}} key={id} title={
          <>
            {!!command.job_url && <a style={{marginRight: '12px'}} href={command.job_url} target="_blank" rel="noopener noreferrer"><Button icon="share">Open Logs</Button></a>}
            <span title={command.command_created_at_datetime}>{DateTime.fromISO(command.command_created_at_datetime, { zone: 'utc' }).toRelative()}</span>
            {!!command.user && ` as ${command.user}`}{!!command.HOST && ` @${command.HOST}`}
          </>}>
          <code>{command.argv.join(" ")}</code>
        </Callout>
      })}
      </div>
    </>

	}
}


export { BatchLogs };
