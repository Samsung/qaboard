import * as React from "react";

import { Button, H5, Intent, Switch, Tag } from "@blueprintjs/core";

// itamar persi
const tags_map = {
  'HM1': ["HM1/crop1", "HM1/crop2"],
  'BPC': ["BPC/crop1", "BPC/crop2"],
};
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
    //onClick: console.log("clicked "),
    // end
  };

  cropFunction() {
    console.log("crop pressed")
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
          onClick={() => this.cropFunction()}
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
