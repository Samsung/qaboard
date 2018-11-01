
		
const parse_hex = (text_string) => {
  let width = parseFloat(text_string.match(/width=(\d+)/)[1])
  let height = parseFloat(text_string.match(/height=(\d+)/)[1])
  let data_array = text_string
                   .split('\n')
                   .slice(0,width*height)
				   .map(parseFloat)
  let newArr = [];
  while(data_array.length)
	  newArr.push(data_array.splice(0,width));
  //  var hover_text = newArr.map((row, i) => row.map((item, j) => { return `i: ${i} <br> j: ${j} <br> ${label}: ${item.toFixed(3)}`}))
  
  return {
    z: newArr,
    // text: hover_text,
    // hoverinfo: 'text',
  };
};
export { parse_hex };

