// The build checks on the media components' props (docs-media/README.md#serving-the-docs-build-fetches-media).
const KIND_OF = {Shot: ['still'], Clip: ['clip', 'tape'], Compare: ['still']};
const REQUIRED = {Shot: ['id'], Clip: ['id'], Compare: ['before', 'after']};

/**
 * Checks the elements of one file. Returns {messages: [{level: 'error'|'warning', line, message}], ids, planned}.
 * `shots` is the manifest's, `shotList` the parsed shots.yaml (null when it isn't available).
 */
function checkElements(elements, {shots, shotList, strict}) {
  const messages = [];
  const ids = new Set();
  const planned = new Set();
  const report = (level, line, message) => messages.push({level, line, message});
  const strictLevel = strict ? 'error' : 'warning';

  for (const element of elements) {
    const {component, props, line} = element;
    element.problems.forEach(problem => report('error', line, problem));
    for (const prop of REQUIRED[component]) {
      if (props[prop] === undefined && !element.dynamic && !element.problems.some(p => p.includes(` ${prop}=`)))
        report('error', line, `<${component}> needs a ${prop}="<area>/<subject>" prop`);
    }
    for (const prop of REQUIRED[component]) {
      const id = props[prop];
      if (id === undefined)
        continue;
      const entry = shots[id];
      const listed = shotList?.[id];
      ids.add(id);
      if (!entry && !listed) {
        if (shotList === null) {
          report(strictLevel, line, `${id}: not in media.json, and docs-media/shots.yaml isn't available to check it`);
          planned.add(id);
        } else {
          report('error', line, `${id}: unknown shot id, it's neither in website/media.json nor in docs-media/shots.yaml`);
        }
        continue;
      }
      if (listed?.status === 'retired')
        report('error', line, `${id}: this shot is retired (docs-media/shots.yaml), use another one`);
      const kind = entry?.kind ?? listed.kind;
      if (!KIND_OF[component].includes(kind))
        report('error', line, `${id} is a ${kind}: use ${kind === 'still' ? '<Shot>' : '<Clip>'}`);
      if (!entry) {
        planned.add(id);
        if (strict)
          report('error', line, `${id}: not published yet (it's in docs-media/shots.yaml, not in website/media.json)`);
      }
      if (component === 'Shot') {
        for (const anchor of element.anchors) {
          if (entry && !entry.anchors?.[anchor])
            report(strictLevel, line, `${id}: the capture didn't record the anchor "${anchor}" used in callouts`);
          else if (!entry && listed && !listed.anchors.includes(anchor))
            report(strictLevel, line, `${id}: list the callout anchor "${anchor}" under its \`anchors\` in docs-media/shots.yaml`);
        }
      }
    }
    if (component === 'Compare') {
      const [before, after] = [shots[props.before], shots[props.after]];
      if (before && after && (before.width !== after.width || before.height !== after.height))
        report('error', line, `<Compare>: ${props.before} is ${before.width}x${before.height} but ${props.after} is ${after.width}x${after.height}, they must have the same size`);
    }
  }
  return {messages, ids, planned};
}

module.exports = {checkElements};
