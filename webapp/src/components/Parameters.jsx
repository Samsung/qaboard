import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Classes,
  Button,
  Tag,
  Intent,
  Callout,
  FormGroup,
  Switch,
  NonIdealState,
  InputGroup,
} from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { fileQuery } from "../api/queries";
import { bit_accuracy_help, humanFileSize } from "../viewers/bit_accuracy/utils";
import { event_value } from "../utils";
import { OutputViewer } from "../viewers/OutputViewer";
import { useSelected, useUrlText, updateSelected } from "../hooks";
import { copyDirectory } from "./logs/DirectoryActions";


// The list of files in a commit's artifacts
const useManifest = url => useQuery(fileQuery(url));

const manifest_url = (commit, artifact) => commit?.artifacts_url ? `${commit.artifacts_url}/manifests/${artifact}.json` : undefined;


// Values that don't need to be in the URL
const url_defaults = { params_artifact: 'configurations', params_show_all_files: false, params_expand_all: true, params_color_blind_friendly: false, params_files_filter: '' };

// Compares the artifacts (e.g. configuration files) of the new and reference commits.
// The options are in the URL.
const CommitParameters = ({ new_commit, ref_commit, config }) => {
  const { query } = useSelected();
  const artifact = query.params_artifact || 'configurations';
  const show_all_files = query.params_show_all_files === 'true';
  const expand_all = query.params_expand_all !== 'false';
  const color_blind_friendly = query.params_color_blind_friendly === 'true';
  const files_filter = query.params_files_filter || '';

  const update = attribute_url => e => updateSelected({ [attribute_url]: event_value(e) }, { defaults: url_defaults });
  const toggle = (attribute_url, value) => () => update(attribute_url)(!value);
  const [files_filter_text, onFilesFilterChange] = useUrlText(files_filter, value => updateSelected({ params_files_filter: value }, { replace: true, defaults: url_defaults }));

  const new_manifest = useManifest(manifest_url(new_commit, artifact));
  const ref_manifest = useManifest(manifest_url(ref_commit, artifact));
  const manifests = useMemo(
    () => ({ new: new_manifest.data, reference: ref_manifest.data }),
    [new_manifest.data, ref_manifest.data],
  );
  const storage = useMemo(
    () => Object.values(new_manifest.data ?? {}).reduce((total, f) => total + (f.st_size ?? 0), 0),
    [new_manifest.data],
  );
  const error = { new: new_manifest.error, reference: ref_manifest.error };
  const is_loaded = !!new_commit?.artifacts_url && !new_manifest.isLoading && !ref_manifest.isLoading;

  if (new_commit === null || new_commit === undefined)
    return <span />;

  const artifacts = Object.keys(config.artifacts || {})

  const help_text = <>
    <p>
      Configurations are defined in your <strong>qaboard.yaml</strong>, eg as <code>artifacts.configurations</code>.
      <br/>
      You can explore all your artifacts:  {artifacts.map((name, idx) => 
          <Button
              key={idx}
              onClick={() => update('params_artifact')(name)}
              intent={name===artifact ? Intent.PRIMARY : null}
              style={{margin: '5px'}}
          >
              {name}
          </Button>
      )}
    </p>
  </>

  const fake_output = {is_failed: false, is_running: false, is_pending: false, metrics: {}}
  const viewer = !is_loaded ? <span/> : <>
    <Tag>Total: {humanFileSize(storage, true)}</Tag>
    <OutputViewer
      key="bit-accuracy"
      type="files/bit-accuracy"
      output_new={{...fake_output, output_dir_url: new_commit.repo_artifacts_url}}
      output_ref={!!ref_commit && {...fake_output, output_dir_url: ref_commit.repo_artifacts_url}}
      manifests={manifests}
      show_all_files={show_all_files}
      expand_all={expand_all}
      files_filter={files_filter}
      color_blind_friendly={color_blind_friendly}
    />
  </>


  const forms = <Callout style={{marginBottom: '20px', display: 'flex', justifyContent: 'space-between'}}>
      <FormGroup
        inline
        labelFor="show-all-files"
        helperText="By default the only files shown are those that are different/added/removed."
        style={{flex: '50 1 auto'}}
      >
        <Switch
          label="Show all files"
          checked={show_all_files}
          onChange={toggle('params_show_all_files', show_all_files)}
          style={{ width: "300px" }}
        />
      </FormGroup>
      <FormGroup
        inline
        labelFor="expand-all"
        style={{flex: '50 1 auto'}}
      >
        <Switch
          label="Expand all folders"
          checked={expand_all}
          onChange={toggle('params_expand_all', expand_all)}
          style={{ width: "300px" }}
        />
        <Switch
          label="Color-blind friendly"
          checked={color_blind_friendly}
          onChange={toggle('params_color_blind_friendly', color_blind_friendly)}
          style={{ width: "300px" }}
        />
      </FormGroup>
      <FormGroup
        inline
        labelFor="files-filter"
        helperText="Only show files matching"
        style={{flex: '50 1 auto'}}
      >
        <InputGroup
          value={files_filter_text}
          placeholder="filter by path"
          onChange={onFilesFilterChange}
          type="search"
          leftIcon="filter"
          style={{ width: "150px" }}
        />
      </FormGroup>
      <span style={{flex: '1 1 auto'}}>{bit_accuracy_help}</span>
  </Callout>

  return <div>
    {help_text}
    {forms}
    {!!error.new ? <NonIdealState
                      title={`Could not find the ${artifact}`}
                      icon="folder-open"
                      description={<>
                        <p>To solve the issue, go to your commit's workspace and call<br/><code>qa save-artifacts</code>.</p>
                        <p className={Classes.TEXT_MUTED}><code>{errorMessage(error.new)}</code></p>
                      </>}
                    />
                 : viewer
    }
    <div style={{margin: '10px'}}>
      <Button style={{margin: '10px'}} className={Classes.TEXT_MUTED} icon="duplicate" onClick={() => copyDirectory(new_commit.artifacts_url, { windows: true })}>
        Copy Path <Tag minimal>windows</Tag>
      </Button>
      <Button style={{margin: '10px'}} label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} icon="duplicate" onClick={() => copyDirectory(new_commit.artifacts_url)}>
        Copy Path <Tag minimal>linux</Tag>
      </Button>
      <a rel="noopener noreferrer" target="_blank" href={new_commit.artifacts_url}><Button style={{margin: '10px'}} className={Classes.TEXT_MUTED} icon="folder-shared-open">
        View in browser
      </Button></a>
    </div>
  </div>
};

export { CommitParameters };
