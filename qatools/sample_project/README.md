# Sample project using `qatools`

Shows a complete flow with:
- **Application:** dummy SLAM that outputs only zeroes.
- **Build process:** described using `cmake`
- **CI:** GitlabCI handles the build
- *Not done*: unit tests
- **`qatools` wraps the quality evaluation tests**
  * offers a CLI API via `qa --help`
  * configuration in *.qatools.yaml*
  * implementation of the `run` and `postprocessing` functions in `main.py`
