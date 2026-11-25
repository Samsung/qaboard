// Register lists pasted from CDE (one site's tools), converted to QA-Board's parameters. Kept apart so that it can
// move to that site's code: the rest of the form only calls model_from_registers, and the editor's paste conversion.
import { row as make_row } from './model';


const parseMatrixToJSON = (matrixStr) => {
  // Remove outer brackets and split by lines/rows
  const content = matrixStr.substring(1, matrixStr.length - 1).trim();
  const rows = content.split(/\s*\n\s*/).map(row => row.trim()).filter(row => row.length > 0);
  const row_values = row => row.split(/\s+/).map(val => {
    const num = parseFloat(val);
    return isNaN(num) ? `"${val}"` : num;
  });
  // a single row is a matrix with one row, for consistency
  return `[${rows.map(row => `[${row_values(row).join(', ')}]`).join(', ')}]`;
};

const is_not_entry = line => !line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#') || !line.includes('=');

/**
 * Converts registers in the CDE format to QA-Board's: the sim|, hal| and def| prefixes go, `=X` becomes `: [X]`.
 *   block.hal|b="text"                       => "block.b": ["text"],
 *   block.def|a=5                            => "block.a": [5]
 *   CMixer_Gains_0.hal|channels_gain=[1 2
 *                                     0 0 ]  => "CMixer_Gains_0.channels_gain": [[[1, 2], [0, 0]]]
 */
export const transformCDERegisters = (text) => {
  const lines = text.split('\n');
  const transformedLines = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#') || !line.includes('=')) {
      transformedLines.push(line);
      i++;
      continue;
    }
    const transformedLine = line.replace(/\.(sim|hal|def)\|/g, '.');
    const equalIndex = transformedLine.indexOf('=');
    const key = transformedLine.substring(0, equalIndex).trim();
    const value = transformedLine.substring(equalIndex + 1).trim();

    if (value.startsWith('[')) {
      // the matrix may go on over several lines
      const matrixLines = [value];
      let j = i + 1;
      let closed = value.endsWith(']');
      while (!closed && j < lines.length) {
        const nextLine = lines[j].trim();
        matrixLines.push(nextLine);
        closed = nextLine.endsWith(']');
        j++;
      }
      if (closed) {
        const comma = lines.slice(j).every(is_not_entry) ? '' : ',';
        transformedLines.push(`"${key}": [${parseMatrixToJSON(matrixLines.join('\n').trim())}]${comma}`);
        i = j;
        continue;
      }
    }

    let formattedValue;
    if (value.startsWith('"') && value.endsWith('"')) formattedValue = `[${value}]`;
    else if (!isNaN(value) && !isNaN(parseFloat(value))) formattedValue = `[${value}]`;
    else formattedValue = `["${value}"]`;
    const comma = lines.slice(i + 1).every(is_not_entry) ? '' : ',';
    transformedLines.push(`"${key}": ${formattedValue}${comma}`);
    i++;
  }
  return transformedLines.join('\n');
};

/**
 * The parameters in pasted register lines, like `block.hal|gain=[1 2 3 4]`, as a model ({sets: [[row]]}),
 * or null if the text isn't register lines.
 */
export const model_from_registers = text => {
  if (!text || !String(text).includes('=')) return null;
  try {
    const parsed = JSON.parse(`{${transformCDERegisters(String(text))}}`);
    const rows = Object.entries(parsed).map(([key, values]) => make_row(key, Array.isArray(values) ? values : [values]));
    return rows.length ? { sets: [rows] } : null;
  } catch {
    return null;
  }
};
