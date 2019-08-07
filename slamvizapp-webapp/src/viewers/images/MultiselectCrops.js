import * as React from "react";
import { Button, Intent, MenuItem } from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";
import { deserialize_config } from './../../utils';
import { Crops } from "./crops";
import AutoCrops from "./AutoCrops"


const Categories = [
  { title: "Pre-defined", intent: Intent.PRIMARY },
  { title: "Automatic ROIs", intent: null },
].map((m, index) => ({ ...m, index: index + 1 }));


class MultiSelectTags extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      createdItems: [],
      categories: [],
      items: categorySelectProps.items,
    };
  }

  componentDidMount() {
    const { output_new } = this.props;
    let items = Categories;
    let configs_with_regions_of_interest =
      deserialize_config(output_new.configuration).filter(c => !!c.roi);
    if (configs_with_regions_of_interest.length) {
      this.setState({ categories: items.filter((c) => c.title === "Pre-defined") })
    }
    else {
      items = items.filter((c) => c.title !== "Pre-defined")
    }

    if (!this.props.output_ref || this.props.output_ref.deleted) {
      items = items.filter((c) => c.title !== "Automatic ROIs")
    }

    this.setState({ items: items })
  }


  render() {
    const { viewer_new, output_new, viewer_ref, output_ref, qatools_config } = this.props;
    const { categories, hasInitialContent, tagMinimal, ...flags } = this.state;
    const getTagProps = (_value, index) => ({
      intent: Categories.filter((c) => c.title === _value)[0].intent,
      minimal: true,
    });

    const clearButton =
      categories.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : undefined;

    const selected_auto_rois = this.state.categories.some(c => c.title === "Automatic ROIs");
    const selected_predefined_rois = this.state.categories.some(c => c.title === "Pre-defined");

    return (
      <>
        <MultiSelect
          {...categorySelectProps}
          {...flags}
          itemRenderer={this.renderCategory}
          items={this.state.items}
          noResults={<MenuItem disabled={true} text="No results." />}
          onItemSelect={this.handleCategorySelect}
          onItemsPaste={this.handleCategoriesPaste}
          tagRenderer={this.renderTag}
          tagInputProps={{ tagProps: getTagProps, onRemove: this.handleTagRemove, rightElement: clearButton }}
          selectedItems={this.state.categories}
          resetOnSelect={true}
          placeholder={"Select region of interest..."}
        />
        <p />
        {selected_auto_rois && <AutoCrops viewer_new={viewer_new} output_new={output_new} viewer_ref={viewer_ref} output_ref={output_ref} path={this.props.path} qatools_config={qatools_config} />}
        {selected_predefined_rois && <Crops viewer={viewer_new} output_new={output_new} />}
      </>
    );
  }


  renderTag = (category) => category.title;

  renderCategory = (category, { modifiers, handleClick }) => {
    if (!modifiers.matchesPredicate) {
      return null;
    }
    return (
      <MenuItem
        active={modifiers.active}
        icon={this.isCategorySelected(category) ? "tick" : "blank"}
        key={category.index}
        onClick={(handleClick)}
        text={`${category.title}`}
        shouldDismissPopover={false}
      />
    );
  };

  handleTagRemove = (_tag, index) => {
    this.deselectCategory(index);
  };

  getSelectedCategoryIndex(category) {
    return this.state.categories.indexOf(category);
  }

  isCategorySelected(category) {
    return this.getSelectedCategoryIndex(category) !== -1;
  }

  selectCategory(category) {
    this.selectCategories([category]);
  }

  selectCategories(categoriesToSelect) {
    const { categories, items } = this.state;

    let nextCategories = categories.slice();
    let nextItems = items.slice();

    categoriesToSelect.forEach(category => {
      nextCategories = [...nextCategories, category];
    });

    this.setState({
      categories: nextCategories,
      items: nextItems,
    });
  }

  deselectCategory(index) {
    const { categories } = this.state;
    this.setState({
      categories: categories.filter((_category, i) => i !== index),
    });
  }

  handleCategorySelect = (category) => {
    if (!this.isCategorySelected(category)) {
      this.selectCategory(category);
    } else {
      this.deselectCategory(this.getSelectedCategoryIndex(category));
    }
  };

  handleCategoriesPaste = (categories) => {
    this.selectCategories(categories);
  };

  handleSwitchChange(prop) {
    return (event) => {
      const checked = event.currentTarget.checked;
      this.setState(state => ({ ...state, [prop]: checked }));
    };
  }

  handleClear = () => this.setState({ categories: [] });
}

//////////////////////////// FUNCTIONS /////////////////////////////////////////

const renderCategory = (category, { handleClick, modifiers, query }) => {
  if (!modifiers.matchesPredicate) {
    return null;
  }
  const text = `${category.index}. ${category.title}`;
  return (
    <MenuItem
      active={modifiers.active}
      disabled={modifiers.disabled}
      key={category.index}
      onClick={handleClick}
      text={
        (text, query)}
    />
  );
};

const filterCategory = (query, category, _index, exactMatch) => {
  const normalizedTitle = category.title.toLowerCase();
  const normalizedQuery = query.toLowerCase();

  if (exactMatch) {
    return normalizedTitle === normalizedQuery;
  } else {
    return `${category.index}. ${normalizedTitle}`.indexOf(normalizedQuery) >= 0;
  }
};

const categorySelectProps = {
  itemPredicate: filterCategory,
  itemRenderer: renderCategory,
  items: Categories,
};

export default MultiSelectTags;
