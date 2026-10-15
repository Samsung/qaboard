import { useState } from "react";

import { http, errorMessage } from "../api/http";
import { linux_to_windows, are_on_same_filesystem, extract_drive_and_folder } from '../utils'

import {
  Intent,
  Tag,
  Callout,
  FormGroup,
  ControlGroup,
  InputGroup,
  Button,
  SegmentedControl,
} from "@blueprintjs/core";

import { toaster } from "../toaster"
import { copyWithToast } from "../utils/clipboard"


// By default we export the files of the first visualization
const default_path = (config, path) => {
  const visualization_path = config?.outputs?.visualizations?.[0]?.path;
  // for projects using dynamic outputs
  if (visualization_path) return visualization_path.replace(/:[a-zA-Z0-9_]+/, '*');
  return path || '*.png';
};

const no_errors = [];

// Exports the outputs' files to a shared directory
const ExportPlugin = props => {
  const { config, batch_dir_url } = props;
  const [edited_path, setEditedPath] = useState(null);
  const [export_dir, setExportDir] = useState("");
  const [export_type, setExportType] = useState("link"); // "copy"
  const [edit_export_dir, setEditExportDir] = useState(false);
  const [is_loading, setLoading] = useState(false);
  const [result, setResult] = useState({ errors: no_errors, nb_files_exported: null });
  const { errors, nb_files_exported, nb_outputs_exported, linux_export_dir, windows_export_dir } = result;

  const path = edited_path ?? default_path(config, props.path);
  const batch_dir = (batch_dir_url ?? '').slice(2);
  const batch_output_fs = extract_drive_and_folder(linux_to_windows(batch_dir));
  const export_dir_is_same_fs = !!export_dir && are_on_same_filesystem(linux_to_windows(export_dir), batch_output_fs);
  // links only work on the same filesystem
  const effective_export_type = (edit_export_dir && !export_dir_is_same_fs) ? "copy" : export_type;

  const export_to_directory = () => {
    setLoading(true);
    const params = {
      path,
      project: props.project,
      ref_project: props.ref_project,
      new_commit_id: props.new_commit_id,
      ref_commit_id: props.ref_commit_id,
      batch_new: props.selected_batch_new,
      batch_ref: props.selected_batch_ref,
      filter_new: props.filter_batch_new,
      filter_ref: props.filter_batch_ref,
      export_type: effective_export_type,
      edit_export_dir: false,
      export_dir: export_dir || undefined,
    };
    http.get('/api/v1/export/', { params })
      .then(({ data }) => {
        const windows_export_dir = linux_to_windows(data.export_dir);
        copyWithToast(windows_export_dir, { what: 'the export directory' });
        setLoading(false);
        setResult({
          linux_export_dir: data.export_dir,
          windows_export_dir,
          nb_files_exported: data.nb_files_exported,
          nb_outputs_exported: data.nb_outputs,
          errors: data.errors ?? no_errors,
        });
      })
      .catch(error => {
        const error_str = errorMessage(error);
        setLoading(false);
        setResult(result => ({ ...result, errors: [error_str] }));
        toaster.show({
          message: error_str,
          intent: Intent.DANGER,
        });
      });
  };

  
  // **/**.png => Invalid pattern: '**' can only be an entire path component
  const invalidPattern = /(?:^|\/)(\*\*(?!\/?$|\/))/;
  const path_has_invalid_globs = invalidPattern.test(path) || path.startsWith("/")

  return <Callout style={{marginBottom: '20px', marginTop: '15px'}}>
    <FormGroup
      labelFor="pluging-copy"
      helperText={<div>
        {path_has_invalid_globs && path.startsWith('/') && <><Tag minimal intent="warning">File patterns must be relative.</Tag><br/></>}
        {path_has_invalid_globs && !path.startsWith('/') && <><Tag minimal intent="warning"><code>**</code> must be entire path components: <code>/**/</code>.</Tag><br/></>}
        Files will be exported as
          {edit_export_dir ? <SegmentedControl
            style={{
              marginLeft: "5px",
              marginRight: "5px",
              marginBottom: "5px",
              background: "none",
              boxShadow: "none",
              border: "1px solid var(--qa-border)",
              boxSizing: "border-box",
            }}
            title={export_dir_is_same_fs ? undefined : `(Hard) Links are only available when exporting to the same filesystem (${batch_output_fs}). We avoid symlinks since they are poorly supported on Windows.`}
            options={[
              {label: "link", value: "link", disabled: !export_dir_is_same_fs},
              {label: "copy", value: "copy"},
            ]}
            onValueChange={setExportType}
            value={effective_export_type}
            inline small outlined
          /> : <><span> </span><strong
                title="Hardlinks, meaning the exported file is the original file available at a different path"
                style={{"textDecoration": "underline wavy"}}
                >links</strong><span> </span></>}
        {!export_dir && <span> in a shared directory</span>}. {!edit_export_dir && <Button
          onClick={() => {
            setEditExportDir(true);
            setExportType("copy");
          }}
          small
          outlined
          icon="edit"
        >Edit where</Button>}
        <br/>
        {edit_export_dir && <InputGroup
          onChange={e => setExportDir(e.target.value)}
          value={export_dir}
          placeholder={'/linux or \\windows path on the shared storage'}
        />}
        You can use <a rel="noopener noreferrer" target="_blank" href="https://docs.python.org/3/library/fnmatch.html">wildcard globs</a>, eg '*.txt' or '**/*.jpg' ('**/' matches 0 or more)
      </div>}
    >
      <ControlGroup>
         <Button
           disabled={path_has_invalid_globs || path.length === 0}
           loading={is_loading}
           icon="download"
           onClick={export_to_directory}
         >Export</Button>
         <InputGroup
           onChange={e => setEditedPath(e.target.value)}
           value={path}
           placeholder={'*.png'}
           aria-label="Files to export (glob pattern)"
           intent={(path_has_invalid_globs || nb_files_exported === 0) ? "warning" : undefined}
         />
      </ControlGroup>
      {linux_export_dir && <div style={{marginTop: '10px'}}>
        <p><Tag>Windows</Tag> <code>{windows_export_dir}</code></p>
        <p><Tag>Linux</Tag> <code>{linux_export_dir}</code></p>
        {effective_export_type === "link" && nb_files_exported !== 0 && <Tag minimal intent="warning" icon="warning-sign">The files are links to the original files, not copies!</Tag>}
      </div>}
      {nb_files_exported !== null && <Tag
          minimal
          icon={nb_files_exported === 0 ? "warning-sign" : "tick"}
          intent={nb_files_exported === 0 ? "warning" : "success"}
        >
        {nb_files_exported} files exported from {nb_outputs_exported} runs{nb_files_exported === 0 && <span>: check files match the pattern <code>{path}</code></span>}.</Tag>}
      {errors.length > 0 && <Callout icon="issue" intent="danger" title="Errors when exporting">
        <ul>{errors.map((e, idx) => {
          return <li key={idx}><code>{e}</code></li>
        })}</ul>
        </Callout>}
    </FormGroup>
  </Callout>
};


export { ExportPlugin };
