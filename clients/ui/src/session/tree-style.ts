export const TREE_STYLE = `
    [data-item-flattened-subitems] {
        display: block;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    [data-item-flattened-subitem] [data-truncate-container],
    [data-item-flattened-subitem] [data-truncate-grid],
    [data-item-flattened-subitem] [data-truncate-grid] > div:first-child,
    [data-item-flattened-subitem] [data-truncate-content="visible"] {
        display: contents;
    }
    [data-item-flattened-subitem] [data-truncate-content="overflow"],
    [data-item-flattened-subitem] [data-truncate-marker-cell] {
        display: none;
    }
`;
