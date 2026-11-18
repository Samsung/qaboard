// What to do when runs have neither visualizations nor metrics: the commit page then can only list their files.
// Users who wrapped their code with `qa` and stopped there are pointed to what makes QA-Board useful.
import { useState } from "react";
import { AnchorButton, Button, Callout, Classes, Collapse, Intent, NonIdealState } from "@blueprintjs/core";

import { useSiteConfig, updateSelected } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { MetricsScript } from "../plugins/ScriptPlugin";

const docs = (docs_root, page) => `${docs_root}docs/${page}`;
const external = { target: '_blank', rel: 'noopener noreferrer' };

// In the Metrics view, when the runs finished without metrics about their results (they all have their compute time).
// `runs`: what MetricsScript needs to list the runs shown. `has_visualizations`: where else to look meanwhile.
export const NoMetricsGuide = ({ runs, has_visualizations, has_compute_time }) => {
  const { docs_root } = useSiteConfig();
  const [show_script, setShowScript] = useState(false);
  return <NonIdealState
    icon="timeline-bar-chart"
    title="No metrics yet"
    description={<div style={{ maxWidth: 560 }}>
      <p>
        {has_compute_time ? 'These runs only say how long they took. ' : ''}
        With metrics, this page summarizes the results, colors what meets your targets, and shows what changed vs the reference.
      </p>
      <p>
        Return them from your <code>run()</code> function, or compute them from the runs' files with a script, without running again.
      </p>
    </div>}
    action={<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
        <AnchorButton icon="manual" text="Return metrics" href={docs(docs_root, 'computing-quantitative-metrics')} {...external}/>
        <Button icon="code" text="Compute them with a script" active={show_script} onClick={() => setShowScript(shown => !shown)}/>
      </div>
      <Collapse isOpen={show_script}>
        <div style={{ textAlign: 'left' }}><MetricsScript {...runs}/></div>
      </Collapse>
      <div className={Classes.TEXT_MUTED} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 4 }}>
        Meanwhile:
        {has_visualizations && <Button variant="minimal" size="small" icon="media" text="Visualizations" onClick={() => updateSelected({ selected_views: 'output-list' })}/>}
        <Button variant="minimal" size="small" icon="folder-open" text="Output files" onClick={() => updateSelected({ selected_views: 'bit-accuracy' })}/>
        <Button variant="minimal" size="small" icon="console" text="Logs" onClick={() => updateSelected({ selected_views: 'logs' })}/>
      </div>
    </div>}
  />;
};

// Above the runs' files, when they have neither visualizations nor metrics: what to set up next. Users can hide it.
export const SetupGuideCallout = ({ project }) => {
  const { docs_root } = useSiteConfig();
  const dismissed = usePrefsStore(state => !!state.setupGuideDismissed?.[project]);
  const dismiss = usePrefsStore(state => state.dismissSetupGuide);
  if (dismissed) return null;
  return <Callout
    icon="lightbulb"
    intent={Intent.PRIMARY}
    title="Get more from your results"
    data-testid="setup-guide"
  >
    <p>
      Your runs have no visualizations or metrics yet, so this page lists the files they created.
      Declare visualizations in <em>qaboard.yaml</em> to compare images, plots or videos side by side with the reference,
      and add metrics to summarize the results and catch regressions. If something looks wrong, the logs show what your code printed.
    </p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <AnchorButton size="small" icon="media" text="Declare visualizations" href={docs(docs_root, 'visualizations')} style={{ textDecoration: 'none' }} {...external}/>
      <Button size="small" icon="timeline-bar-chart" text="Add metrics" onClick={() => updateSelected({ selected_views: 'summary' })}/>
      <Button size="small" icon="console" text="Logs" onClick={() => updateSelected({ selected_views: 'logs' })}/>
      <Button size="small" variant="minimal" text="Hide" title="Hide this guide for this project" onClick={() => dismiss(project)} style={{ marginLeft: 'auto' }}/>
    </div>
  </Callout>;
};
