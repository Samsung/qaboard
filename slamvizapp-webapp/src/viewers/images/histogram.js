var empty = Array(256);
for (var i = 0; i < 256; i++) {
  empty[i] = 0;
}

const rgb = {
  'new': [
     {name: 'Red', color: 'red', 'legendgroup': 'Red'},
     {name: 'Green', color: 'green', 'legendgroup': 'Green'},
     {name: 'Blue', color: 'blue', 'legendgroup': 'Blue'},
     {name: 'Y', color: 'black', 'legendgroup': 'Y'},
   ],
  'ref': [
     {name: 'Red', color: 'pink', 'legendgroup': 'Red'},
     {name: 'Green', color: 'yellowgreen', 'legendgroup': 'Green'},
     {name: 'Blue', color: 'aqua', 'legendgroup': 'Blue'},
     {name: 'Y', color: 'darkgrey', 'legendgroup': 'Y'},
  ]
}


const histogram_traces = (viewer, rect, label) =>  {
  if (rect !== null && rect !== undefined) {
    var { x, y, width, height } = rect;
  } else {
    x = 0
    y = 0
    height = viewer.drawer.canvas.height;
    width =  viewer.drawer.canvas.width;
  }
  var context = viewer.drawer.context
  var data = [0, 1, 2, 3].map(() => empty.slice());
  let total_pixels = 0
  try {
    var p = context.getImageData(x, y, width, height).data
    for(let i=0; i < p.length; i++ /*alpha*/) {
      // https://en.wikipedia.org/wiki/YUV#Converting_between_Y%E2%80%B2UV_and_RGB
      let Y = 0.299 * p[i] + 0.587 * p[i+1] + 0.114 * p[i+2];
      data[3][Math.round(Y)]++

      data[0][p[i++]]++; // r
      data[1][p[i++]]++; // g
      data[2][p[i++]]++; // b
      total_pixels += 1 
    }
  } catch(e) {
    console.log(e)
  }

  return data.map( (y, idx) => ({
    type: 'scatter',
    fill: 'tozeroy',
    x: Object.keys(y),
    y: y.map(e => e / total_pixels),
    name: label,
    legendgroup: rgb[label][idx].legendgroup,
    // fillcolor: '#ab63fa',
    // line: {
      // color: '#ab63fa'
    // }
    marker: {
       ...rgb[label][idx],
       opacity: 0.5,
    },
  }))
}

export { histogram_traces };
