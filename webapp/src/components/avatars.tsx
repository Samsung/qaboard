// Avatars of committers, users and projects.
// Often there is no picture: the git host doesn't know the committer, the image fails to load...
// Then we show initials on a color derived from the name, so people and projects keep the same color everywhere.
import { useState } from "react";
import type { CSSProperties, MouseEventHandler } from "react";
import styled from "styled-components";
import { Classes, Colors } from "@blueprintjs/core";

import { Link } from "../router";
import { project_avatar_style } from "../utils";
import { image_url } from "../git";


// White text has a contrast of at least 4.5:1 on all of them,
// and they stand out both on the light pages and in the dark sidebar.
export const avatar_colors = [
  Colors.BLUE3, Colors.CERULEAN3, Colors.TURQUOISE2, Colors.GREEN3, Colors.LIME2, Colors.GOLD2,
  Colors.ORANGE2, Colors.VERMILION3, Colors.ROSE3, Colors.VIOLET3, Colors.INDIGO3, Colors.SEPIA3,
];

// FNV-1a: stable across sessions and browsers
const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// Same name, same color. Without a name (e.g. while loading), gray.
export const avatarColor = (name?: string | null) => {
  const key = (name ?? "").trim().toLowerCase();
  return key ? avatar_colors[hash(key) % avatar_colors.length] : Colors.GRAY3;
};

// "Alice Martin", "alice.martin" or "alice.martin@example.com" => "AM", a project like "group/repo" => "R"
export const initials = (name?: string | null, max_letters = 2) => {
  const last_part = (name ?? "").split("/").pop() ?? "";
  const letters = last_part.split("@")[0].split(/[\s._-]+/)
    .map(word => word.match(/[\p{L}\p{N}]/u)?.[0])
    .filter(letter => !!letter);
  if (letters.length === 0) return "";
  return (letters.length > 1 && max_letters > 1 ? `${letters[0]}${letters[letters.length - 1]}` : `${letters[0]}`).toUpperCase();
};

const font_family = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

// An image, so that the fallback is laid out, styled and described (alt) exactly like a picture
export const initialsImage = (name?: string | null, max_letters = 2) => {
  const text = initials(name, max_letters);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">`
    + `<rect width="40" height="40" fill="${avatarColor(name)}"/>`
    + `<text x="20" y="20" dy=".35em" text-anchor="middle" fill="#fff" font-family='${font_family}' font-size="${text.length > 1 ? 16 : 19}" font-weight="600">${text}</text>`
    + `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

// Avatars from public git hosts are loaded directly. The others go through the backend:
// it adds our credentials, can reach hosts users can't, and only fetches from known hosts (see git.js)
export const proxiedImage = (url?: string | null): string | null => image_url(url);


const AvatarCell = styled.div<{ $size: string }>`
  flex: 0 0 auto;
  width: ${props => props.$size};
  height: ${props => props.$size};
  align-self: center;
  line-height: 0;
`;

const AvatarImg = styled.img<{ $size: string }>`
  width: ${props => props.$size};
  height: ${props => props.$size};
  border-radius: 50%;
  border: 1px solid rgba(17, 20, 24, 0.1);
  object-fit: cover;
  .${Classes.DARK} & {
    border-color: rgba(255, 255, 255, 0.2);
  }
`;

type AvatarProps = {
  // who or what: for the initials, the color, the alt text and the tooltip
  name?: string | null,
  src?: string | null,
  // a page of the app
  href?: string | null,
  onClick?: MouseEventHandler,
  size?: string,
  className?: string,
  style?: CSSProperties,
  // only for pictures, e.g. to tint subprojects' avatars
  img_style?: CSSProperties | null,
};

export function Avatar({ name, src, href, onClick, size = "45px", className, style, img_style }: AvatarProps) {
  // We try again if the URL changes
  const [failed_src, setFailedSrc] = useState<string | null>(null);
  const has_image = !!src && src !== failed_src;
  // two letters would be too small to read
  const max_letters = parseFloat(size) < 24 ? 1 : 2;
  const avatar = <AvatarImg
    $size={size}
    src={has_image ? src : initialsImage(name, max_letters)}
    alt={name ?? ""}
    title={name ?? undefined}
    style={has_image ? img_style ?? undefined : undefined}
    onError={has_image ? () => setFailedSrc(src) : undefined}
    loading="lazy"
    decoding="async"
  />;
  return <AvatarCell $size={size} className={className} style={style}>
    {href ? <Link to={href} onClick={onClick}>{avatar}</Link> : avatar}
  </AvatarCell>;
}


type Commit = {
  committer_name?: string | null,
  committer_avatar_url?: string | null,
};

// Links to the committer's commits
export function CommitAvatar({ commit, project, ...props }: { commit?: Commit | null, project?: string } & Omit<AvatarProps, "name" | "src" | "href">) {
  const committer = commit?.committer_name;
  return <Avatar
    name={committer}
    src={proxiedImage(commit?.committer_avatar_url)}
    href={committer && project ? `/${project}/committer/${committer}` : null}
    {...props}
  />;
}


type ProjectData = {
  git?: { avatar_url?: string | null, path_with_namespace?: string },
  qatools_config?: { project?: { avatar_url?: string | null } },
};

// Projects can set an avatar in qaboard.yaml (project.avatar_url), otherwise we use their git repository's.
// Subprojects using their repository's avatar get their own tint.
export function ProjectAvatar({ project, data, ...props }: { project: string, data?: ProjectData | null } & Omit<AvatarProps, "name" | "src" | "img_style">) {
  const custom_avatar_url = data?.qatools_config?.project?.avatar_url;
  const is_subproject = data?.git?.path_with_namespace !== project;
  return <Avatar
    name={project}
    src={proxiedImage(custom_avatar_url ?? data?.git?.avatar_url)}
    img_style={is_subproject && !custom_avatar_url ? project_avatar_style(project) : null}
    {...props}
  />;
}
