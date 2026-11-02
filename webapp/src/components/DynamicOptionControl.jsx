import { HTMLSelect, Slider } from '@blueprintjs/core';

// The input of a dynamic option: a slider over consecutive numbers (e.g. frames), else a select.
// Without selectedValue but with a defaultLabel (e.g. "Each run's last"), it says that each run shows its own default:
// the select gets it as its first entry, the slider's handle sits at the end the default is at.
// Choosing that entry calls onChange(undefined).
const DynamicOptionControl = ({
  name,
  label = name,
  option,
  selectedValue,
  defaultLabel,
  defaultRule = 'first',
  onChange,
  disabled = false,
  showLabel = false,
  style = {}
}) => {
  if (!option.values || option.values.length === 0) {
    return null;
  }

  const unset = (selectedValue === undefined || selectedValue === null) && !!defaultLabel;
  const valueToUse = selectedValue || option.values[0];

  const handleChange = (value) => {
    if (typeof onChange === 'function') {
      onChange(value);
    }
  };

  const label_element = showLabel && (
    <div style={{ fontSize: '12px', color: 'var(--qa-text-muted)', marginBottom: '4px' }}>
      {label}
    </div>
  );

  if (option.type === 'slider') {
    const value = unset ? (defaultRule === 'last' ? option.max : option.min) : parseFloat(valueToUse);
    return (
      // the handle shows the value: the ends are enough as labels.
      // Blueprint's slider overflows its box by half a handle on each side
      <div style={{ padding: '0 8px', ...style }}>
        {label_element}
        <Slider
          value={value}
          min={option.min}
          max={option.max}
          onChange={(value) => {
            const rawValue = option.toRaw?.[value] || value;
            handleChange(rawValue);
          }}
          labelValues={[option.min, option.max]}
          labelRenderer={(value, opts) => opts?.isHandleTooltip && unset ? (defaultRule === 'last' ? 'Last' : 'First') : value}
          showTrackFill={!unset}
          disabled={disabled}
          handleHtmlProps={{ 'aria-label': label, 'aria-valuetext': unset ? defaultLabel : undefined }}
        />
      </div>
    );
  } else {
    return (
      <div style={style}>
        {label_element}
        <HTMLSelect
          value={unset ? '' : valueToUse}
          onChange={(e) => handleChange(e.target.value === '' ? undefined : e.target.value)}
          disabled={disabled || option.values.length === 1}
          fill
          aria-label={label}
        >
          {defaultLabel && <option value="">{defaultLabel} (default)</option>}
          {option.values.map(value => (
            <option key={value} value={value}>{value}</option>
          ))}
        </HTMLSelect>
      </div>
    );
  }
};

export default DynamicOptionControl;
