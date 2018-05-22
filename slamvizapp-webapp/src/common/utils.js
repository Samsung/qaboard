const calendarStrings = {
  lastDay : '[Yesterday]',
  sameDay : '[Today]',
  nextDay : '[Tomorrow]',
  lastWeek : '[last] dddd',
  nextWeek : 'dddd',
  sameElse : 'L'
};

const groupBy = (array, prop) => {
  return array.reduce(function(groups, item) {
    var val = item[prop];
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {});
};

const groupByObject = (array, prop) => {
  return array.reduce(function(groups, item) {
    var val = JSON.stringify(item[prop]);
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {});
};


const empty_output = {metrics: undefined, extra_parameters: {}};

// Finds the most matching output from a batch
const matching_output = ({output, batch}) => {
  // high => more different
  const match_score = o => 5*(o.configuration!==output.configuration|0) +
                           3*(o.platform!==output.platform|0) +
                           1*(JSON.stringify(o.extra_parameters)!==JSON.stringify(output.extra_parameters)|0);

  // let soft_match = true;
  let matching_outputs = Object.values(batch.outputs || [])
                                   .filter(o => !o.is_pending && !o.is_failed)
                                   .filter(o => o.recording_path===output.recording_path)
                                   // .filter(o => o.platform===output.platform || soft_match)
                                   // .filter(o => o.configuration===output.configuration || soft_match)
                                   // We prefer to compare an ouput versus a similar one
                                   .sort( (a,b) => match_score(a) - match_score(b))
  // if (matching_outputs) console.log(matching_outputs)
  let output_ref = matching_outputs[0] || empty_output;
  let imperfect_match = match_score(output_ref)>0;
  let warning = imperfect_match && matching_outputs.length>0 ? `vs ${output_ref.configuration} @${output_ref.platform}  with ${JSON.stringify(output_ref.extra_parameters)}` : null;
  return {output_ref, warning, imperfect_match}
}

export { groupBy, groupByObject, matching_output, calendarStrings };
