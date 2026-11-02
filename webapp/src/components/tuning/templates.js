const templates = {
  "no tuning": "",
  "none": "{}",
  "simple-combinations": JSON.stringify(
    {
      "block.register_en": [0, 1],
      "some_parameter_str": ["a", "b"],
    },
    null,
    2
  ),
  "list-of-combinations": JSON.stringify(
    [
      {
        min_events_per_frame: 5e3,
        max_events_per_frame: 10e3
      },
      {
        min_events_per_frame: 15e3,
        max_events_per_frame: 20e3
      }
    ],
    null,
    2
  ),
  "1x2 matrix": JSON.stringify(
    {
      "block.register_1x2_matrix": [[0, 0], [1, 1]],
    },
    null,
    2
  ),
  "function":
    `// you can write a javascript function that return your tuning search

// ========================================= //
// Example A: test 10 values from 0 to 100
samples = 10;
scale = 10;


// 1. Using Iterators, return a tuning set
range = [...Array(samples).keys()]
return {
  "my_block|parameter_enable": 1,
  "my_block|parameter": range.map(i => scale * i),
}

// 2. Using Iterators, return a list of tuning sets
return range.map(i => ({
  "my_block|parameter": scale * i,
  "my_block|parameter_enable": 1,
}))

// 3. Using for loops
search = []
for (var i = 0; i <= 10; i++) {
  search.push({
    "my_block|parameter": scale * i,
    "my_block|parameter_enable": 1,
  })
}
return search



// ========================================= //
// Example A: test 10 values from 0 to 100
//            for a specific matrix value
return {
  "my_block|parameter_enable": 1,
  "my_block|parameter": range.map( i => [0, 0, 0, i * scale, 0])	
}

`
};


export default templates;
