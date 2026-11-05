// A run's name: the label of its input's metadata, else its input (absolute when its database is /)
export const runName = output => {
  if (output.test_input_metadata?.label) return output.test_input_metadata.label
  if (output.output_type === "pipeline" || output.test_input_path === "PIPELINE") return `${output.data?.batch} (pipeline)`
  return `${output.test_input_database === '/' ? '/' : ''}${output.test_input_path}`
}
