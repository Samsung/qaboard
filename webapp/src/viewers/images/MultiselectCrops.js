import * as React from "react";
import { Button, Intent, MenuItem } from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";
import { Crops } from "./crops";
import AutoCrops from "./AutoCrops"



class MultiSelectTags extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      ...this.defaultRoiGroups(props),
    };
  }

  defaultRoiGroups = props => {
    let available_roi_groups = []
    let selected_roi_groups = []

    const predefined_rois_group = {
      title: "Pre-defined",
      intent: Intent.PRIMARY,
    }
    const { output_new, output_ref } = props;
    let has_predefined_regions_of_interest = output_new.configurations.some(c => !!c.roi);
    if (has_predefined_regions_of_interest) {
      available_roi_groups.push(predefined_rois_group)
      selected_roi_groups.push(predefined_rois_group)
    }

    let has_available_new = !!output_new && !output_new.deleted
    let has_available_ref = !!output_ref && !output_ref.deleted
    if (has_available_new && has_available_ref)
      available_roi_groups.push({
        title: "Automatic ROIs",
      })

    return {
      available_roi_groups,
      selected_roi_groups,
    }
  }

  componentDidUpdate(prevProps, prevState) {
    const { output_new, output_ref } = this.props;
    const has_new = output_new !== undefined && output_new !== null;
    const has_ref = output_ref !== undefined && output_ref !== null;
    let updated_new = has_new && (prevProps.output_new === null || prevProps.output_new === undefined || prevProps.output_new !== output_new);
    let updated_ref = has_ref && (prevProps.output_ref === null || prevProps.output_ref === undefined || prevProps.output_ref !== output_ref);
    if (updated_new || updated_ref) {
      this.setState(this.defaultRoiGroups(this.props))
    }
  }


  render() {
    const { available_roi_groups, selected_roi_groups } = this.state;
    const clearButton = selected_roi_groups.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : undefined;
    const getTagProps = (_value, index) => {
      const roi_group = selected_roi_groups.filter(c => c.title === _value)[0]
      return {
        intent: !!roi_group ? roi_group.intent : null,
        minimal: true,
      }
    };

    const selected_auto_rois = selected_roi_groups.some(c => c.title === "Automatic ROIs");
    const selected_predefined_rois = selected_roi_groups.some(c => c.title === "Pre-defined");
    return (
      <>
        <MultiSelect
          items={available_roi_groups}
          selectedItems={selected_roi_groups}
          itemPredicate={(query, roi_group) => roi_group.title.toLowerCase().includes(query.toLowerCase())}
          itemRenderer={this.renderRoiGroup}
          tagRenderer={roi_group => roi_group.title}
          tagInputProps={{
            tagProps: getTagProps,
            onRemove: this.handleTagRemove,
            rightElement: clearButton
          }}
          placeholder="Select region of interest..."
          noResults={<MenuItem disabled text="No ROIs." />}
          onItemSelect={this.handleRoiGroupSelect}
          onItemsPaste={this.handleCategoriesPaste}
          resetOnSelect={true}
        />
        <p />
        {selected_auto_rois && <AutoCrops {...this.props} />}
        {selected_predefined_rois && <Crops viewer={this.props.viewer_new} output_new={this.props.output_new} />}
      </>
    );
  }

  renderRoiGroup = (group, { modifiers, handleClick }) => {
    if (!modifiers.matchesPredicate)
      return null;
    return (
      <MenuItem
        active={modifiers.active}
        icon={this.isRoiGroupSelected(group) ? "tick" : "blank"}
        key={group.title}
        onClick={(handleClick)}
        text={group.title}
        shouldDismissPopover={false}
      />
    );
  };

  handleTagRemove = (_tag, index) => {
    this.deselectRoiGroup(index);
  };

  getSelectedRoiGroupIndex(roi_group) {
    return this.state.selected_roi_groups.indexOf(roi_group);
  }

  isRoiGroupSelected(roi_group) {
    return this.getSelectedRoiGroupIndex(roi_group) !== -1;
  }

  selectRoiGroup(roi_group) {
    this.selectRoiGroups([roi_group]);
  }

  selectRoiGroups(groupsToSelect) {
    const { selected_roi_groups, available_roi_groups } = this.state;
    let next_selected_roi_groups = selected_roi_groups.slice();
    let next_available_roi_groups = available_roi_groups.slice();
    groupsToSelect.forEach(roi_group => {
      next_selected_roi_groups = [...next_selected_roi_groups, roi_group];
    });
    this.setState({
      selected_roi_groups: next_selected_roi_groups,
      available_roi_groups: next_available_roi_groups,
    });
  }

  deselectRoiGroup(index) {
    this.setState({
      selected_roi_groups: this.state.selected_roi_groups.filter((_roi_group, i) => i !== index),
    });
  }

  handleRoiGroupSelect = (roi_group) => {
    if (!this.isRoiGroupSelected(roi_group))
      this.selectRoiGroup(roi_group);
    else
      this.deselectRoiGroup(this.getSelectedRoiGroupIndex(roi_group));
  };

  handleCategoriesPaste = (roi_groups) => {
    this.selectRoiGroups(roi_groups);
  };

  handleClear = () => this.setState({ selected_roi_groups: [] });
}


export default MultiSelectTags;
