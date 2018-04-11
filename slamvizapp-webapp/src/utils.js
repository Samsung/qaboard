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

// const groupByObject = (array, prop) => {
//   return array.reduce(function(groups, item) {
//     let val = JSON.stringify(item[prop]);
//     groups[val] = groups[val] || [];
//     groups[val].push(item);
//     return groups;
//   }, {});
// };

export { groupBy, calendarStrings };
