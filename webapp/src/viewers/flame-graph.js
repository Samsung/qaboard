import React from "react";
import { get, all, CancelToken } from "axios";
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
var flameGraph = require('d3-flame-graph');

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


let last_id = 0;
const make_id = () => {
  last_id += 1;
  return `flame-graph-${last_id}`;
}

class FlameGraphComponent extends React.Component {
  constructor(props) {
    super(props);
    this.legend = React.createRef();
    this.flamegraph = React.createRef();
    this.id = make_id()
    this.state = {
      g: null,
      zoomed: false,
      search: '',
    };
    // const width = this.props.style?.width || 1180;
    this.chart = flameGraph.flamegraph()
                           .transitionDuration(250)
                           .width(1180)
                           .height(400)
                           .title(props.title)
                           .onClick(this.onClick)
                           .differential(props.differential ?? false)
    this.chart.inverted(true) // icicle plot
  }
  onClick = frame => {
    if (!!frame.parent)
      this.setState({zoomed: true})
  }
  componentDidMount() {
    this.g = select(this.flamegraph)
    this.g = select(`#${this.id}`)
    // this.state.g.selectAll("*").remove();
    const data = this.props.data
    this.g.datum(data).call(this.chart)
    this.chart.setDetailsElement(this.legend.current)
  }
  shouldComponentUpdate(nextProps, nextState) {
    // console.log("shouldComponentUpdate ? ")
    if(nextState.zoomed!==this.state.zoomed || nextState.search!==this.state.search){
      return true
    }
    if (nextProps.data !== this.props.data || nextProps.title !== this.props.title || nextProps.differential !== this.props.differential) {
      // console.log("YES")
      return true
    }
    return false
  }

  componentDidUpdate(prevProps) {
    // console.log("[componentDidUpdate]", prevProps, this.props)
    if (prevProps.data !== this.props.data) {
      this.chart.update(this.props.data)
    }
    if (prevProps.differential !== this.props.differential) {
      const differential = this.props.differential ?? false;
      // console.log("diff =>", differential)
      this.chart = this.chart.differential(differential)
      // TODP: check out what this does exactly...
      // this.chart.elided(this.props.differential)
    }
  }

  componentWillUnmount() {
    this.chart.destroy();
  }

  render() {
    // console.log("[render]")
    const { zoomed, search } = this.state;
    return <>
      <InputGroup
        value={search}
        type="search"
        placeholder="Highlight frames"
        intent={!!search ? Intent.PRIMARY : undefined}
        leftIcon="search"
        onChange={this.search}
        style={{width:'1180px'}}
      />
      <div className="flame-graph" id={this.id} ref={this.flamegraph} />
      {zoomed && <Button style={{margin: "5px"}} icon="zoom-out" onClick={this.resetZoom}>Zoom Out</Button>}
      <span className={Classes.MONOSPACE_TEXT} ref={this.legend}/>
    </>
  }
  resetZoom = () => {
    this.setState({zoomed: false})
    this.chart.resetZoom()
  } 
  clear = () => {
    this.setState({search: ''})
    this.chart.clear()
  }
  search = e => {
    const search = e.target.value;
    this.setState({search})
    this.chart.search(search)
  }
}

class FlameGraphViewer extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      error: null,
      comparaison: 'diff-what-did-happen', // 'diff-what-will-happen' | 'new' | 'ref' | 'both'
      cancel_source: CancelToken.source(),
      data: {},
    };
  }


  componentDidMount() {
    this.getData(this.props)
  }

  getData(props, label) {
    const { output_new, output_ref, path } = props;
    const { cancel_source } = this.state;
    if (!output_new.output_dir_url || !path) return;

    let results = [];
    const should_get_all = label === undefined || label === null;
    if (should_get_all || label === 'new') {
      results.push(['new', `${output_new.output_dir_url}/${path}`])
    }
    if (should_get_all || label === 'ref') {
      if (!!output_ref && !!output_ref.output_dir_url)
        results.push(['ref', `${output_ref.output_dir_url}/${path}`])
    }

    const load_data = label => response => {
      const data = response.data || {}
      const map = {}
      forEachInTree(data, (node, id) => map[id] = node)
      this.setState((previous_state, props) => ({
        data: {
          ...previous_state.data,
          [label]: data,
        },
        map: {
          ...previous_state.map,
          [label]: map,
        },
      }))
    }

    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: cancel_source.token})
                    .then(load_data(label))
                    .catch(response => {
                      // we don't really care about errors for ref / groundtruth outputs
                      if (label==='new' && !!response)
                        this.setState({error: response.data})
                    });
    }).map(f=>f()) )
    // now we loaded and parsed all the data
    .then( () => this.setState({is_loaded: true}) )
  }


  componentWillUnmount() {
    if (!!this.state.cancel_source)
      this.state.cancel_source.cancel();
  }

  componentDidUpdate(prevProps, prevState) {
      const has_path = this.props.path !== undefined && this.props.path !== null;
      let updated_path = has_path && (prevProps.path === null || prevProps.path === undefined || prevProps.path !== this.props.path);

      const has_new = this.props.output_new !== undefined && this.props.output_new !== null;
      const has_ref = this.props.output_ref !== undefined && this.props.output_ref !== null;
      let updated_new = has_new && (prevProps.output_new === null || prevProps.output_new === undefined || prevProps.output_new.id !== this.props.output_new.id);
      let updated_ref = has_ref && (prevProps.output_ref === null || prevProps.output_ref === undefined || prevProps.output_ref.id !== this.props.output_ref.id);
      if (updated_new || updated_path) {
        this.getData(this.props, 'new');
      }
      if (updated_ref || updated_path) {
        this.getData(this.props, 'ref');
      }
  }

  render() {
    const { error, is_loaded, data, map, comparaison } = this.state;
    // console.log(data.new)
    const makeDelta = (map_ref, invert) => {
      return (node, id) => {
        const node_ref = map_ref[id]
        node.delta = node.value - (node_ref?.value || 0)
        if (invert)
          node.delta = -node.delta
      }
    }
    if (!!data.ref && !!data.new) {
      // widths show the after profile, colored by what DID happen
      forEachInTree(data.new, makeDelta(map.ref))
      // widths show the before profile, colored by what WILL happen
      forEachInTree(data.ref, makeDelta(map.new, true))
    }    
    // iconProps={{icon: 'warning-sign'}}
    return <>
        <div>
        {!!error && <span>{JSON.stringify(error)}</span>}
        {is_loaded && !!data.new && !!!data.ref && <FlameGraphComponent key="new" data={data.new}/>}
        {is_loaded && !!data.new && !!data.ref && comparaison==='diff-what-did-happen' &&  <FlameGraphComponent differential title="Widths show the after profile, colored by what DID happen" key="new1" data={data.new}/>}
        {is_loaded && !!data.new && !!data.ref && comparaison==='diff-what-will-happen' && <FlameGraphComponent differential title="Widths show the before profile, colored by what WILL happen" key="new2" data={data.ref}/>}
        {is_loaded && !!data.new && !!data.ref && (comparaison==='new' || comparaison==='both') && <FlameGraphComponent key="new3" data={data.new}/>}
        {is_loaded && !!data.new && !!data.ref && (comparaison==='ref' || comparaison==='both') && <FlameGraphComponent key="ref" data={data.ref}/>}
        </div>
        <div>
        <HTMLSelect
          onChange={e => this.setState({comparaison: e.currentTarget.value})}
          value={!!data.ref ? comparaison : 'new'}
          style={{ marginBottom: '8px' }}
          options={[
            {value: 'diff-what-did-happen',  label: 'What did happen'},
            {value: 'diff-what-will-happen',  label: 'What will happen'},
            {value: 'new',  label: 'After'},
            {value: 'ref',  label: 'Before'},
            {value: 'both', label: 'After & Before'},
          ]}
        />
        <Popover hoverCloseDelay={500} interactionKind={"hover"} inheritDarkTheme portalClassName={Classes.DARK}>
          <p><Icon icon="info-sign" style={{ marginLeft: '8px', color: Colors.GRAY2 }} /></p>
          <div style={{ padding: '15px' }}>
            <p>Read about <a rel="noopener noreferrer" href="http://www.brendangregg.com/flamegraphs.html"target="_blank">Frame Graphs</a></p>
            <p>And the <a rel="noopener noreferrer" href="http://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html"target="_blank">Differential Flame Graphs</a> versions</p>
          </div>
        </Popover>
        
        </div>
    </>      
  }
}

// Walk depth depth, starting by the root
const forEachInTree = (tree, callback, id) => {
  if (tree === undefined || tree === null)
    return;
  const current_id = `${id ?? ''}/${tree.name}`
  callback(tree, current_id)
  if (tree.children === undefined || tree.children === null) {
    return;
  }
  tree.children.forEach(t => {
    forEachInTree(t, callback, current_id);
  })
 }



export default FlameGraphViewer;
