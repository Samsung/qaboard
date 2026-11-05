import { useState } from "react";

import { Button, Classes, PopoverNext, SegmentedControl, Tooltip } from "@blueprintjs/core";
import styled from "styled-components";

import { useSiteConfig } from "../hooks";
import { path_segment } from "../selection";
import { copyWithToast } from "../utils/clipboard";


export const script_help = "Work on the runs shown from a script: copy a Python or shell snippet that lists them";

// The address of what the page shows, as qaboard.runs(url) and `qa runs <url>` read it (like selection.js does): the
// project, commit, batch and filter, without the view, the sorting or the other settings of the page.
export const runs_url = ({ project, commit_id, batch, filter, ref_project, ref_commit_id, batch_ref, filter_ref, origin = window.location.origin }) => {
  const params = new URLSearchParams();
  if (batch) params.set('batch', batch);
  if (filter) params.set('filter', filter);
  if (ref_commit_id) {
    params.set('reference', ref_commit_id);
    // the reference's batch defaults to "default", not to the new batch
    if (batch_ref && batch_ref !== 'default') params.set('batch_ref', batch_ref);
    if (filter_ref) params.set('filter_ref', filter_ref);
    if (ref_project && ref_project !== project) params.set('ref_project', ref_project);
  }
  const query = params.toString();
  return `${origin}/${path_segment(project)}/commit/${commit_id ? path_segment(commit_id) : ''}${query ? `?${query}` : ''}`;
};

// PEP 723 header: `uv run script.py` installs these. The server says what to install besides qaboard, e.g. a site package.
const script_header = requirements => `# /// script
# dependencies = [${requirements.map(r => JSON.stringify(r)).join(', ')}]
# ///
`;

export const python_snippet = (url, requirements = ['qaboard']) => `${script_header(requirements)}import qaboard as qb

for run in qb.runs("${url}"):                       # the runs this page shows, with the filter
    run.input, run.configs, run.params, run.metrics  # what each run is, and its metrics
    run.output_dir / "output.png"                    # its files
    # run.log_metrics({"sharpness": 0.4})            # add metrics: who, when and which script are recorded
    # run.log_artifact("sharpness/map.png", path)    # add a file to the run
`;

export const shell_snippet = url => `qa runs "${url}"               # one folder per line
qa runs "${url}" --json        # inputs, configs, params, metrics, folders...
`;

export const install_command = (requirements = ['qaboard']) => `pip install --upgrade ${requirements.map(r => (/[\s@#]/.test(r) ? `'${r}'` : r)).join(' ')}`;

const Snippet = styled.pre`
  margin: 8px 0;
  padding: 8px 10px;
  max-width: 560px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.4;
  user-select: all;
`;

const Content = styled.div`
  padding: 12px;
  max-width: 600px;
`;


// A snippet that lists the runs shown, for people who want to post-process them from a script
const ScriptPlugin = props => {
  const { docs_root, cli_requirements } = useSiteConfig();
  const [language, setLanguage] = useState('python');
  const url = runs_url(props);
  const requirements = cli_requirements?.length ? cli_requirements : ['qaboard'];
  const snippet = language === 'python' ? python_snippet(url, requirements) : shell_snippet(url);
  const content = <Content>
    <p className={Classes.TEXT_MUTED} style={{ marginBottom: 8 }}>
      Work on the runs shown from a script: read their metrics and files, add metrics or files to them. The filter is in the address.
      {' '}<a href={`${docs_root}docs/apis#runs-in-scripts`} target="_blank" rel="noopener noreferrer">All the APIs</a>
    </p>
    <SegmentedControl
      small
      value={language}
      onValueChange={setLanguage}
      options={[{ label: 'Python', value: 'python' }, { label: 'Shell', value: 'shell' }]}
    />
    <Snippet className={Classes.CODE_BLOCK} data-testid="script-snippet">{snippet}</Snippet>
    <Button icon="duplicate" text="Copy" variant="outlined" size="small" onClick={() => copyWithToast(snippet, { what: 'the snippet' })}/>
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 10, marginBottom: 0 }}>
      Save it as <code>script.py</code> and run <code>uv run script.py</code>: the header installs what it needs. Or install it yourself,
      {' '}<code data-testid="install-command">{install_command(requirements)}</code>. Sign in once with <code>qa auth login</code> to read private projects and to add metrics or files.
    </p>
  </Content>;
  return <PopoverNext content={content} placement="bottom-end">
    <Tooltip content={script_help} placement="top" openOnTargetFocus={false}>
      <Button variant="outlined" icon="code" text="Script" aria-label="Use the runs in a script"/>
    </Tooltip>
  </PopoverNext>;
};


export { ScriptPlugin };
