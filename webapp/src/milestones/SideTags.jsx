// Where milestones are on the commit page, in the milestones menus and the Manage dialog: "new", "ref", "ref 2"...
// with a dot of their side's color, like the reference tabs. See comparison_sides in ./api.js
import { Intent, Tag } from "@blueprintjs/core";


// The tags that say where milestones are on the page: a dot of their side's color
export const side_tag_style = `
  .qa-side-tag::before {
    content: '';
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 4px;
    border-radius: 50%;
    background: var(--side-color, currentColor);
    vertical-align: middle;
  }
`;

// Where a milestone is on the commit page: "new", "ref 2"..., with their colors, like the reference tabs
export const SideTags = ({ sides }) => sides.map(side => <Tag
  key={side.role}
  minimal
  round
  className="qa-side-tag"
  intent={side.is_shown || side.role === 'new' ? Intent.PRIMARY : undefined}
  title={side.title}
  style={{ '--side-color': side.color }}
>
  {side.role}
</Tag>);

