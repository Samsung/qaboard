import React from "react";
import {
  Colors,
  Icon,
  Tooltip,
  Intent,
  Toaster,
} from "@blueprintjs/core";
import copy from 'copy-to-clipboard';


function cropSelection(viewer, coords, selection) {

  if (coords) {

    const real_coords = viewer.viewport.viewportToImageRectangle(selection.rect);


    const to_clipboard =
      `- \{` +
      `x: ${Math.round(real_coords.x)}, ` +
      `y: ${Math.round(real_coords.y)}, ` +
      `w: ${Math.round(real_coords.width)}, ` +
      `h: ${Math.round(real_coords.height)}, ` +
      `label: }`;

    return (
      <Tooltip intent={Intent.SUCCESS}>
        <Icon icon="clipboard" onClick={() => Copy(to_clipboard)} color={Colors.VIOLET2} iconSize={Icon.SIZE_LARGE} />
        <ul>
          <p> Copy to clipboard</p>
          <p>{to_clipboard}</p>
        </ul>
      </Tooltip>
    )
  }
}

function Copy(text) {

  const toaster = Toaster.create();
  copy(text);
  toaster.show({ message: "Copied!", intent: Intent.SUCCESS, timeout: 3000 });
}

export default cropSelection;