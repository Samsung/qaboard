import React from 'react';
import { HTMLSelect, Slider } from '@blueprintjs/core';

const DynamicOptionControl = ({ 
  name, 
  option, 
  selectedValue, 
  onChange, 
  disabled = false,
  small = false,
  showLabel = false,
  style = {}
}) => {
  if (!option.values || option.values.length === 0) {
    return null;
  }
  
  // Use selectedValue or fall back to first available value
  const valueToUse = selectedValue || option.values[0];

  const controlStyle = {
    ...(showLabel ? {} : {
      marginLeft: '5px',
      marginRight: '5px',
      paddingLeft: '5px',
      paddingRight: '5px'
    }),
    ...style
  };

  const handleChange = (value) => {
    if (typeof onChange === 'function') {
      onChange(value);
    }
  };

  if (option.type === 'slider') {
    const labelStepSize = Math.pow(10, Math.floor(Math.log10(option.max - option.min)));
    return (
      <div style={controlStyle} title={showLabel ? undefined : name}>
        {showLabel && (
          <div style={{ fontSize: '12px', color: '#5c7080', marginBottom: '4px' }}>
            {name}
          </div>
        )}
        <Slider
          value={parseFloat(valueToUse)}
          min={option.min}
          max={option.max}
          onChange={(value) => {
            const rawValue = option.toRaw?.[value] || value;
            handleChange(rawValue);
          }}
          labelStepSize={labelStepSize}
          showTrackFill
          disabled={disabled}
        />
      </div>
    );
  } else {
    return (
      <div style={controlStyle} title={showLabel ? undefined : name}>
        {showLabel && (
          <div style={{ fontSize: '12px', color: '#5c7080', marginBottom: '4px' }}>
            {name}
          </div>
        )}
        <HTMLSelect
          value={valueToUse}
          onChange={(e) => handleChange(e.target.value)}
          disabled={disabled || option.values.length === 1}
          fill
          small={small}
        >
          {option.values.map(value => (
            <option key={value} value={value}>{value}</option>
          ))}
        </HTMLSelect>
      </div>
    );
  }
};

export default DynamicOptionControl;