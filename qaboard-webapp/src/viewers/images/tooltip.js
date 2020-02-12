import React from "react";
import { Tag } from "@blueprintjs/core";

const margin = {marginLeft: '10px'};
const colorFormat = color => color.toString().padStart('x', 3)
const coordFormat = coord => Math.round(coord).toString().padStart('x', 5)


class ColorTooltip extends React.PureComponent {
	render() {
		if (this.props.color === undefined || this.props.color === null)
			return <span/>
		const { r, g, b } = this.props.color;
        const color = `rgb(${colorFormat(r)}, ${colorFormat(g)}, ${colorFormat(b)})`;
        return <span style={margin}>
            <Tag style={{background: color, ...margin}} round></Tag>
            <code style={margin}>{color}</code>
        </span>
	}
}

class CoordTooltip extends React.PureComponent {
	render() {
		if (this.props.color === undefined || this.props.color === null)
			return <span/>
		const { x, y } = (this.props.color || {}).imageCoordinates || {};

        return <span style={margin}>
            <code>x: {coordFormat(x)}, y: {coordFormat(y)}</code>
        </span>
	}
}



export { ColorTooltip, CoordTooltip };