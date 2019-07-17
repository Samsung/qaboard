const parse_hex = (text, convert_nan ) => {
  if (!!!text) return {z: null}
  // console.log(text)
  let width = parseFloat(text.match(/width=(\d+)/)[1])
  let height = parseFloat(text.match(/height=(\d+)/)[1])
  let data_array = text
                   .split('\n')
                   .slice(0, width * height)
		   .map(parseFloat)
  if (convert_nan){
	  data_array = data_array.map(x => x <= 0 ? NaN : x)
  }
  let newArr = [];
  while(data_array.length)
    newArr.push(data_array.splice(0, width));
  //  var hoover_text = newArr.map((row, i) => row.map((item, j) => { return `i: ${i} <br> j: ${j} <br> ${label}: ${item.toFixed(3)}`}))

  return {
    z: newArr,
    // text: hover_text,
    // hoverinfo: 'text',
  };
};
export { parse_hex };

