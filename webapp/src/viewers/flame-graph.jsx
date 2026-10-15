import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Colors,
  Classes,
  Intent,
  Button,
  InputGroup,
  HTMLSelect,
  Popover,
  Icon,
} from "@blueprintjs/core";
import { select } from 'd3-selection'
import * as flameGraph from 'd3-flame-graph';
import { forEachInTree, selfDelta } from './flameDeltas';

import { errorMessage } from "../api/http";
import { fileQuery } from "../api/queries";

// Integrates 
// We love Brendan Gregg's flame charts
//   http://www.brendangregg.com/flamegraphs.html.
// and integrated Martin Spier's
//   https://github.com/spiermar/d3-flame-graph


// References on integrating d3 & react
// - https://gist.github.com/alexcjohnson/a4b714eee8afd2123ee00cb5b3278a5f
// - https://nicolashery.com/integrating-d3js-visualizations-in-a-react-app/
// - https://cmichel.io/how-to-use-d3js-in-react
// - https://www.smashingmagazine.com/2018/02/react-d3-ecosystem/


// TODO: Use white text on dark backgrounds (ends of the diff color scale)
// TODO: Check whether we should implement the normalization
//       from http://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html
// TODO: The animations could be smoother if we reused and updated the same d3 graph
//       but we had prop sync issues and used key="$unique" to force recreating graphs...
// TODO: Let's sync the search and zoom between the 2 viewers when showing both after/before
// TODO: Hide zoomed-into frames, otherwise we can't explore deep stacks (max-height..)


// We could also consider using
// - https://react-flame-graph.now.sh/
// - https://github.com/bvaughn/react-flame-graph
// It could be more performance for large flame graphs, but it doesn't support diff out of the box.

// We could also use embed speedscope
//   http://jamie-wong.com/post/speedscope/
// by just copying the entrypoint and changing the render root:
//   https://github.com/jlfwong/speedscope/blob/master/src/speedscope.tsx
// But no there are no diffs
//   https://github.com/jlfwong/speedscope/issues/228
// and there would be some work involved anyway...


// Files are cached: switching between views doesn't fetch them again


// Wraps d3-flame-graph, which renders imperatively in a DOM element.
// We create a new chart when the data changes: parents use different keys to show different graphs.
const FlameGraphComponent = ({ data, title, differential = false }) => {
  const container = useRef(null);
  const legend = useRef(null);
  const chart = useRef(null);
  const [zoomed, setZoomed] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const instance = flameGraph.flamegraph()
                               .transitionDuration(250)
                               .width(1180)
                               .title(title)
                               .onClick(frame => { if (frame.parent) setZoomed(true) })
                               .computeDelta(differential)
                               .inverted(true) // icicle plot
    // red for frames that take more time, blue for less, orange for new ones
    if (differential)
      instance.setColorMapper(flameGraph.differentialColorMapper)
    // d3-flame-graph writes in the data (e.g. to hide frames when zooming), we give it a copy
    select(container.current).datum(structuredClone(data)).call(instance);
    instance.setDetailsElement(legend.current);
    chart.current = instance;
    return () => {
      instance.destroy();
      chart.current = null;
    }
  }, [data, title, differential]);

  const resetZoom = () => {
    setZoomed(false)
    chart.current?.resetZoom()
  }
  const onSearch = e => {
    const search = e.target.value;
    setSearch(search)
    chart.current?.search(search)
  }

  return <>
    <InputGroup
      value={search}
      type="search"
      placeholder="Highlight frames"
      intent={search ? Intent.PRIMARY : undefined}
      leftIcon="search"
      onChange={onSearch}
      style={{width:'1180px'}}
    />
    <div className="flame-graph" ref={container} />
    {zoomed && <Button style={{margin: "5px"}} icon="zoom-out" onClick={resetZoom}>Zoom Out</Button>}
    <span className={Classes.MONOSPACE_TEXT} ref={legend}/>
  </>
}


const index_tree = tree => {
  const map = {};
  forEachInTree(tree, (node, id) => map[id] = node);
  return map;
}

// A copy of the tree, where each frame's delta is its self delta versus the other tree:
// d3-flame-graph's computeDelta adds up the children's deltas
const with_deltas = (tree, map_other, invert, id) => {
  if (tree === undefined || tree === null)
    return tree;
  const current_id = `${id ?? ''}/${tree.name}`
  const delta = selfDelta(tree, map_other[current_id]);
  return {
    ...tree,
    delta: invert ? -delta : delta,
    children: tree.children?.map(t => with_deltas(t, map_other, invert, current_id)),
  };
}


const FlameGraphViewer = ({ output_new, output_ref, path }) => {
  const [comparaison, setComparaison] = useState('diff-what-did-happen'); // 'diff-what-will-happen' | 'new' | 'ref' | 'both'
  const url_new = output_new?.output_dir_url && path ? `${output_new.output_dir_url}/${path}` : undefined;
  const url_ref = url_new && output_ref?.output_dir_url ? `${output_ref.output_dir_url}/${path}` : undefined;
  const query_new = useQuery(fileQuery(url_new, { is_running: output_new?.is_running }));
  // we don't really care about errors for the reference
  const query_ref = useQuery(fileQuery(url_ref, { is_running: output_ref?.is_running }));

  const data_new = query_new.data || undefined;
  const data_ref = query_ref.data || undefined;
  const deltas = useMemo(() => {
    if (!data_new || !data_ref) return {};
    return {
      // widths show the after profile, colored by what DID happen
      new: with_deltas(data_new, index_tree(data_ref)),
      // widths show the before profile, colored by what WILL happen
      ref: with_deltas(data_ref, index_tree(data_new), true),
    };
  }, [data_new, data_ref]);

  const is_loaded = !!url_new && !query_new.isPending && (!url_ref || !query_ref.isPending);
  const both = is_loaded && !!data_new && !!data_ref;
  return <>
      <div>
      {query_new.isError && <span>{errorMessage(query_new.error)}</span>}
      {is_loaded && !!data_new && !data_ref && <FlameGraphComponent key="new" data={data_new}/>}
      {both && comparaison==='diff-what-did-happen' && <FlameGraphComponent differential title="Widths show the after profile, colored by what DID happen" key="new1" data={deltas.new}/>}
      {both && comparaison==='diff-what-will-happen' && <FlameGraphComponent differential title="Widths show the before profile, colored by what WILL happen" key="new2" data={deltas.ref}/>}
      {both && (comparaison==='new' || comparaison==='both') && <FlameGraphComponent key="new3" data={deltas.new}/>}
      {both && (comparaison==='ref' || comparaison==='both') && <FlameGraphComponent key="ref" data={deltas.ref}/>}
      </div>
      <div>
      <HTMLSelect
        onChange={e => setComparaison(e.currentTarget.value)}
        value={data_ref ? comparaison : 'new'}
        style={{ marginBottom: '8px' }}
        options={[
          {value: 'diff-what-did-happen',  label: 'What did happen (runtimes from new, colored with improvement new vs ref)'},
          {value: 'diff-what-will-happen',  label: 'What will happen (runtimes from ref, colored with improvement new vs ref)'},
          {value: 'new',  label: 'After (new)'},
          {value: 'ref',  label: 'Before (ref)'},
          {value: 'both', label: 'After & Before'},
        ]}
      />
      <Popover
        hoverCloseDelay={500}
        interactionKind={"hover"}
        inheritDarkTheme
        popoverClassName={Classes.DARK}
        content={<div style={{ padding: '15px' }}>
          <p>Read about <a rel="noopener noreferrer" href="http://www.brendangregg.com/flamegraphs.html" target="_blank">Flame Graphs</a></p>
          <p>And the <a rel="noopener noreferrer" href="http://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html" target="_blank">Differential Flame Graphs</a> versions</p>
        </div>}
      >
        <p><Icon icon="info-sign" style={{ marginLeft: '8px', color: Colors.GRAY2 }} /></p>
      </Popover>
      </div>
  </>
}


export default FlameGraphViewer;
