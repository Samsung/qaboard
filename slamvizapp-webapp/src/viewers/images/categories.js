import { MenuItem } from "@blueprintjs/core";
import * as React from "react";


export const Categories = [
    { title: "HM1", year: " " },
    { title: "BPC", year: " " },
].map((m, index) => ({ ...m, index: index + 1 }));

export const renderCategory = (category, { handleClick, modifiers, query }) => {
    if (!modifiers.matchesPredicate) {
        return null;
    }
    const text = `${category.index}. ${category.title}`;
    return (
        <MenuItem
            active={modifiers.active}
            disabled={modifiers.disabled}
            label={category.year.toString()}
            key={category.index}
            onClick={handleClick}
            text={highlightText(text, query)}
        />
    );
};

export const renderCreateCategoryOption = (query, active, handleClick) => (
    <MenuItem
        icon="add"
        text={`Create "${query}"`}
        active={active}
        onClick={handleClick}
        shouldDismissPopover={false}
    />
);

export const filterCategory = (query, category, _index, exactMatch) => {
    const normalizedTitle = category.title.toLowerCase();
    const normalizedQuery = query.toLowerCase();

    if (exactMatch) {
        return normalizedTitle === normalizedQuery;
    } else {
        return `${category.index}. ${normalizedTitle} ${category.year}`.indexOf(normalizedQuery) >= 0;
    }
};

function highlightText(text, query) {
    let lastIndex = 0;
    const words = query
        .split(/\s+/)
        .filter(word => word.length > 0)
        .map(escapeRegExpChars);
    if (words.length === 0) {
        return [text];
    }
    const regexp = new RegExp(words.join("|"), "gi");
    const tokens = [];
    while (true) {
        const match = regexp.exec(text);
        if (!match) {
            break;
        }
        const length = match[0].length;
        const before = text.slice(lastIndex, regexp.lastIndex - length);
        if (before.length > 0) {
            tokens.push(before);
        }
        lastIndex = regexp.lastIndex;
        tokens.push(<strong key={lastIndex}>{match[0]}</strong>);
    }
    const rest = text.slice(lastIndex);
    if (rest.length > 0) {
        tokens.push(rest);
    }
    return tokens;
}

function escapeRegExpChars(text) {
    return text.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}

export const categorySelectProps = {
    itemPredicate: filterCategory,
    itemRenderer: renderCategory,
    items: Categories,
};

export function createCategory(title) {
    return {
        index: 100 + Math.floor(Math.random() * 100 + 1),
        title,
        year: new Date().getFullYear(),
    };
}

export function areCategoriesEqual(categoryA, categoryB) {
    // Compare only the titles (ignoring case) just for simplicity.
    return categoryA.title.toLowerCase() === categoryB.title.toLowerCase();
}

export function doesCategoryEqualQuery(category, query) {
    return category.title.toLowerCase() === query.toLowerCase();
}

export function arrayContainsCategory(categories, categoryToFind) {
    return categories.some((category) => category.title === categoryToFind.title);
}

export function addCategoryToArray(categories, categoryToAdd) {
    return [...categories, categoryToAdd];
}

export function deleteCategoryFromArray(categories, categoryToDelete) {
    return categories.filter(category => category !== categoryToDelete);
}

export function maybeAddCreatedCategoryToArrays(
    items,
    createdItems,
    category,
) {
    const isNewlyCreatedItem = !arrayContainsCategory(items, category);
    return {
        createdItems: isNewlyCreatedItem ? addCategoryToArray(createdItems, category) : createdItems,
        // Add a created category to `items` so that the category can be deselected.
        items: isNewlyCreatedItem ? addCategoryToArray(items, category) : items,
    };
}

export function maybeDeleteCreatedCategoryFromArrays(
    items,
    createdItems,
    category,
) {
    const wasItemCreatedByUser = arrayContainsCategory(createdItems, category);

    // Delete the item if the user manually created it.
    return {
        createdItems: wasItemCreatedByUser ? deleteCategoryFromArray(createdItems, category) : createdItems,
        items: wasItemCreatedByUser ? deleteCategoryFromArray(items, category) : items,
    };
}