import React from "react";
import { Tag } from "@blueprintjs/core";


class ColorTooltip extends React.PureComponent {
	render() {
		if (this.props.color === undefined || this.props.color === null)
			return <span/>

		const { r, g, b } = this.props.color;
        const color = `rgb(${r.toString().padStart(3, " ")}, ${g.toString().padStart(3, " ")}, ${b.toString().padStart(3, " ")})`;
        return <span style={{marginLeft: '10px'}}>
            <Tag style={{background: color}} round></Tag>
            <code style={{marginLeft: '10px'}}>{color}</code>
        </span>
	}
}

export { ColorTooltip };