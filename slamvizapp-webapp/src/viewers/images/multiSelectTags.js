import * as React from "react";

import { Button, H5, Intent, ITagProps, MenuItem } from "@blueprintjs/core";
import { ItemRenderer, MultiSelect } from "@blueprintjs/select";
import {
    areCategoriesEqual,
    arrayContainsCategory,
    createCategory,
    categorySelectProps,
    ICategory,
    maybeAddCreatedCategoryToArrays,
    maybeDeleteCreatedCategoryFromArrays,
    renderCreateCategoryOption,
    Categories,
} from "./categories";

// itamar persi
import Tags from "./tags"
import { thisExpression } from "@babel/types";
// end

const CategoryMultiSelect = MultiSelect.ofType();

const INTENTS = [Intent.NONE, Intent.PRIMARY, Intent.SUCCESS, Intent.DANGER, Intent.WARNING];



class MultiSelectTags extends React.PureComponent {
    state = {
        allowCreate: false,
        createdItems: [],
        fill: false,
        categories: [],
        hasInitialContent: false,
        intent: false,
        items: categorySelectProps.items,
        openOnKeyDown: false,
        popoverMinimal: true,
        resetOnSelect: true,
        tagMinimal: false,
    };

    handleAllowCreateChange = this.handleSwitchChange("allowCreate");
    handleKeyDownChange = this.handleSwitchChange("openOnKeyDown");
    handleResetChange = this.handleSwitchChange("resetOnSelect");
    handlePopoverMinimalChange = this.handleSwitchChange("popoverMinimal");
    handleTagMinimalChange = this.handleSwitchChange("tagMinimal");
    handleFillChange = this.handleSwitchChange("fill");
    handleIntentChange = this.handleSwitchChange("intent");
    handleInitialContentChange = this.handleSwitchChange("hasInitialContent");

    render() {
        const { allowCreate, categories, hasInitialContent, tagMinimal, popoverMinimal, ...flags } = this.state;
        const getTagProps = (_value, index) => ({
            intent: this.state.intent ? INTENTS[index % INTENTS.length] : Intent.NONE,
            minimal: tagMinimal,
        });

        const initialContent = this.state.hasInitialContent ? (
            <MenuItem disabled={true} text={`${Categories.length} items loaded.`} />
        ) : (
                // explicit undefined (not null) for default behavior (show full list)
                undefined
            );
        const maybeCreateNewItemFromQuery = allowCreate ? createCategory : undefined;
        const maybeCreateNewItemRenderer = allowCreate ? renderCreateCategoryOption : null;

        const clearButton =
            categories.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : undefined;

        // itamar persi
        const ActiveTags = ({ categories }) => (
            <>
                {categories.map(category => (
                    <Tags category={category.title} />
                ))}
            </>
        );
        // end

        return (
            <>
                <CategoryMultiSelect
                    {...categorySelectProps}
                    {...flags}
                    createNewItemFromQuery={maybeCreateNewItemFromQuery}
                    createNewItemRenderer={maybeCreateNewItemRenderer}
                    initialContent={initialContent}
                    itemRenderer={this.renderCategory}
                    itemsEqual={areCategoriesEqual}
                    // we may customize the default categorySelectProps.items by
                    // adding newly created items to the list, so pass our own
                    items={this.state.items}
                    noResults={<MenuItem disabled={true} text="No results." />}
                    onItemSelect={this.handleCategorySelect}
                    onItemsPaste={this.handleCategoriesPaste}
                    popoverProps={{ minimal: popoverMinimal }}
                    tagRenderer={this.renderTag}
                    tagInputProps={{ tagProps: getTagProps, onRemove: this.handleTagRemove, rightElement: clearButton }}
                    selectedItems={this.state.categories}

                />

                {/* itamar persi */}
                <p />
                <ActiveTags categories={this.state.categories} />

                {/* end */}
            </>
        );
    }


    renderTag = (category) => category.title;

    // NOTE: not using Categories.itemRenderer here so we can set icons.
    renderCategory = (category, { modifiers, handleClick }) => {
        if (!modifiers.matchesPredicate) {
            return null;
        }
        return (
            <MenuItem
                active={modifiers.active}
                icon={this.isCategorySelected(category) ? "tick" : "blank"}
                key={category.index}
                label={category.year.toString()}
                onClick={(handleClick)}
                text={`${category.index}. ${category.title}`}
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
        const { createdItems, categories, items } = this.state;

        let nextCreatedItems = createdItems.slice();
        let nextCategories = categories.slice();
        let nextItems = items.slice();

        categoriesToSelect.forEach(category => {
            const results = maybeAddCreatedCategoryToArrays(nextItems, nextCreatedItems, category);
            nextItems = results.items;
            nextCreatedItems = results.createdItems;
            // Avoid re-creating an item that is already selected (the "Create
            // Item" option will be shown even if it matches an already selected
            // item).
            nextCategories = !arrayContainsCategory(nextCategories, category) ? [...nextCategories, category] : nextCategories;
        });

        this.setState({
            createdItems: nextCreatedItems,
            categories: nextCategories,
            items: nextItems,
        });
    }

    deselectCategory(index) {
        const { categories } = this.state;

        const category = categories[index];
        const { createdItems: nextCreatedItems, items: nextItems } = maybeDeleteCreatedCategoryFromArrays(
            this.state.items,
            this.state.createdItems,
            category,
        );

        // Delete the item if the user manually created it.
        this.setState({
            createdItems: nextCreatedItems,
            categories: categories.filter((_category, i) => i !== index),
            items: nextItems,
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
        // On paste, don't bother with deselecting already selected values, just
        // add the new ones.
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

export default MultiSelectTags;