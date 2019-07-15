import * as React from "react";

import { Button, H5, Intent, Switch, Tag } from "@blueprintjs/core";

// itamar persi
var OpenSeadragon = require('openseadragon')

// itamar persi
const tags_map = {
  'HM2': ["HM2/crop1", "HM2/crop2", "HM2/crop3"],
  'GBPC': ["GBPC/crop1", "GBPC/crop2"],
};

const crops = {
  "HM2/crop1":
  {
    masterZoom: 4.3,
    masterCenter: new OpenSeadragon.Point(0.5, 0.5),
  },
  "HM2/crop2":
  {
    masterZoom: 5.16,
    masterCenter: new OpenSeadragon.Point(0.27, 0.46),
  },
  "HM2/crop3":
  {
    masterZoom: 2.5,
    masterCenter: new OpenSeadragon.Point(0.6, 0.174),
  },
  "GBPC/crop1":
  {
    masterZoom: 12.0,
    masterCenter: new OpenSeadragon.Point(0.5, 0.47),
  },
  "GBPC/crop2":
  {
    masterZoom: 12.0,
    masterCenter: new OpenSeadragon.Point(0.5, 0.35),
  },
}

// end

const INTENTS = [
  { label: "None", value: Intent.NONE },
  { label: "Primary", value: Intent.PRIMARY },
  { label: "Success", value: Intent.SUCCESS },
  { label: "Warning", value: Intent.WARNING },
  { label: "Danger", value: Intent.DANGER },
];

class Tags extends React.PureComponent {
  state = {
    fill: false,
    icon: false,
    intent: Intent.PRIMARY, // TODO: rotate through Intents for all categories
    interactive: true,
    large: false,
    minimal: false,
    removable: false,
    rightIcon: false,
    round: true,
    // itamar persi
    tags: tags_map[this.props.category],
    // end
  };


  render() {
    const { icon, removable, rightIcon, tags, onClick, ...tagProps } = this.state;
    const tagElements = tags.map(tag => {
      const onRemove = () => this.setState({ tags: this.state.tags.filter(t => t !== tag) });
      return (
        <Tag
          key={tag}
          onRemove={removable && onRemove}
          icon={icon === true ? "home" : undefined}
          rightIcon={rightIcon === true ? "map" : undefined}
          onClick={() => this.props.cropFunction(crops[tag])}
          {...tagProps}

        >
          {tag}
        </Tag>
      );
    });
    return (
      <div>
        {tagElements}
      </div>
    );
  }
}

export default Tags;
