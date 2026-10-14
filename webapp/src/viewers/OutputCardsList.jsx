import { useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { Button, Callout, Intent } from "@blueprintjs/core";

import { useSelected, useUrlText, updateSelected } from "../hooks";
import { BitAccuracyForm, bit_accuracy_url_defaults } from "./bit_accuracy/utils";
import { OutputCard } from "./OutputCard";


// Cards are light until they scroll into view: they only then fetch their files and render viewers.
// We render all the cards of usual batches, so that the browser's search (Ctrl+F) finds them.
// Batches with thousands of outputs are rendered incrementally, as users scroll down.
const all_at_once = 300;
const page_size = 100;

function OutputCardsList({ type, project, config, metrics, new_commit, new_batch, ref_batch, controls, onRegisterOutputOptions, onToggleDynamicOptionSync }) {
  // bit-accuracy controls, saved in the URL. They don't add browser history entries.
  const { query } = useSelected();
  const flag = name => query[name] === 'true';
  const [show_all_files, hide_runs_without_files, expand_all, color_blind_friendly] = ['show_all_files', 'hide_runs_without_files', 'expand_all', 'color_blind_friendly'].map(flag);
  const save = (name, value) => updateSelected({ [name]: value }, { replace: true, defaults: bit_accuracy_url_defaults });
  const [files_filter, onFilesFilterChange] = useUrlText(query.files_filter || '', value => save('files_filter', value));
  const update = name => name === 'files_filter' ? onFilesFilterChange : e => save(name, e?.target?.value ?? e);
  const toggle = name => () => save(name, !flag(name));

  const outputs = useMemo(() => (new_batch?.filtered?.outputs ?? [])
    .map(id => [id, new_batch.outputs[id]])
    .filter(([, output]) => output && output.output_type !== "optim_iteration"),
  [new_batch]);

  const [nb_shown, setNbShown] = useState(all_at_once);
  const { ref: more_ref, inView: want_more } = useInView({ rootMargin: '2000px 0px', fallbackInView: true });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (want_more && nb_shown < outputs.length) setNbShown(nb_shown => nb_shown + page_size);
  }, [want_more, nb_shown, outputs.length]);

  const incomplete = nb_shown < outputs.length;
  return (
    <>
      {incomplete && <Callout intent={Intent.PRIMARY} icon="info-sign" style={{ marginBottom: '10px' }}>
        <p>
          {outputs.length} runs: more cards are shown as you scroll, so the browser's search (Ctrl+F) doesn't find them all yet.
          Filter runs from the navbar, or{" "}
          <Button small onClick={() => setNbShown(outputs.length)}>show all {outputs.length} runs</Button>
        </p>
      </Callout>}
      {type === 'bit_accuracy' && <BitAccuracyForm
                                   show_all_files={show_all_files}
                                   hide_runs_without_files={hide_runs_without_files}
                                   expand_all={expand_all}
                                   files_filter={files_filter}
                                   color_blind_friendly={color_blind_friendly}
                                   toggle={toggle}
                                   update={update}
                                  />
      }
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          flexFlow: "row wrap",
        }}
      >
        {outputs.slice(0, nb_shown).map(([id, output]) => <OutputCard
          key={id}
          output_type={output.output_type}
          output_new={output}
          output_ref={ref_batch?.outputs?.[output.reference_id]}
          project={project}
          config={config}
          metrics={metrics}
          commit={new_commit}
          controls={controls}
          type={type}
          show_all_files={show_all_files}
          hide_runs_without_files={hide_runs_without_files}
          files_filter={files_filter}
          expand_all={expand_all}
          color_blind_friendly={color_blind_friendly}
          onRegisterOutputOptions={onRegisterOutputOptions}
          onToggleDynamicOptionSync={onToggleDynamicOptionSync}
        />)}
      </div>
      {incomplete && <div ref={more_ref} style={{ height: '1px' }} />}
    </>
  );
}


export { OutputCardsList }
