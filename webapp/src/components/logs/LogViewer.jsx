import React, { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import styled, { createGlobalStyle } from "styled-components";
import {
  AnchorButton,
  Button,
  ButtonGroup,
  Classes,
  Colors,
  InputGroup,
  Intent,
  NonIdealState,
  SegmentedControl,
  Spinner,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import { toaster } from "../../toaster";
import { useLogTail } from "./useLogTail";
import { createLineParser } from "./logLines";


// Rendering more lines gets slow
const MAX_LINES = 50000
// Searching more matches gets slow
const MAX_MATCHES = 5000
const LINE_HEIGHT = 18


export const formatBytes = bytes => {
  if (bytes === null || bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}


const usePersistentState = (key, initial) => {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key)
      return stored === null ? initial : JSON.parse(stored)
    } catch {
      return initial
    }
  })
  const set = useCallback(next => {
    setValue(next)
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // e.g. private browsing
    }
  }, [key])
  return [value, set]
}


// Search matches are highlighted with the CSS Custom Highlight API, without changing the DOM.
// The highlights are shared by all the viewers on the page: each one adds and removes its own ranges.
// https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
const supportsHighlights = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined'
const shared_highlights = {}
const getHighlight = name => {
  if (!shared_highlights[name]) {
    shared_highlights[name] = new Highlight()
    CSS.highlights.set(name, shared_highlights[name])
  }
  return shared_highlights[name]
}

const HighlightStyles = createGlobalStyle`
  ::highlight(qa-log-match) {
    background-color: rgba(251, 179, 96, 0.55);
  }
  ::highlight(qa-log-current) {
    background-color: ${Colors.ORANGE3};
    color: ${Colors.WHITE};
  }
`

// Range for the characters [start, end[ of the text in an element
const textRange = (element, start, end) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent.length
    if (!started && start < offset + length) {
      range.setStart(node, start - offset)
      started = true
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
  }
  return null
}


const Frame = styled.div`
  position: relative;
  border: 1px solid ${Colors.LIGHT_GRAY1};
  border-radius: 4px;
  background: ${Colors.WHITE};
  overflow: hidden;
  max-width: 1400px;
  .${Classes.DARK} & {
    border-color: ${Colors.DARK_GRAY5};
    background: ${Colors.DARK_GRAY1};
  }
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 5px 6px;
  background: ${Colors.LIGHT_GRAY5};
  border-bottom: 1px solid ${Colors.LIGHT_GRAY2};
  .${Classes.DARK} & {
    background: ${Colors.DARK_GRAY3};
    border-bottom-color: ${Colors.DARK_GRAY5};
  }
  .spacer {
    flex: 1;
  }
  .meta {
    font-size: 12px;
    white-space: nowrap;
  }
  .search {
    width: 230px;
  }
  .search-count {
    font-size: 12px;
    margin-right: 2px;
    font-variant-numeric: tabular-nums;
  }
`

const Notice = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
  background: ${Colors.LIGHT_GRAY4};
  border-bottom: 1px solid ${Colors.LIGHT_GRAY2};
  .${Classes.DARK} & {
    background: ${Colors.DARK_GRAY4};
    border-bottom-color: ${Colors.DARK_GRAY5};
  }
`

const Body = styled.div`
  position: relative;
  overflow: auto;
  max-height: ${props => props.$tall ? 'calc(100vh - 200px)' : '480px'};
  min-height: ${3 * LINE_HEIGHT + 8}px;
  padding: 4px 0;
  font-size: 12px;
  line-height: ${LINE_HEIGHT}px;
  color: ${Colors.DARK_GRAY1};
  .${Classes.DARK} & {
    color: ${Colors.LIGHT_GRAY5};
  }
  &:focus {
    outline: none;
  }

  .line {
    display: flex;
    min-height: ${LINE_HEIGHT}px;
    min-width: 100%;
    width: ${props => props.$wrap ? 'auto' : 'max-content'};
    border-left: 3px solid transparent;
  }
  .line:hover {
    background: rgba(143, 153, 168, 0.12);
  }
  .line.error {
    background: rgba(205, 66, 70, 0.09);
    border-left-color: ${Colors.RED3};
  }
  .line.warning {
    background: rgba(200, 118, 25, 0.08);
    border-left-color: ${Colors.ORANGE3};
  }
  /* Without the CSS Custom Highlight API, we can only highlight lines */
  .line.match {
    background: ${props => props.$highlights ? 'transparent' : 'rgba(251, 179, 96, 0.18)'};
  }
  .line.current {
    background: rgba(251, 179, 96, ${props => props.$highlights ? 0.14 : 0.36});
    border-left-color: ${Colors.ORANGE3};
  }
  .number {
    flex: none;
    position: sticky;
    left: 0;
    box-sizing: content-box;
    width: ${props => props.$digits}ch;
    padding: 0 10px 0 8px;
    text-align: right;
    color: ${Colors.GRAY3};
    background: ${Colors.WHITE};
    user-select: none;
    .${Classes.DARK} & {
      background: ${Colors.DARK_GRAY1};
      color: ${Colors.GRAY1};
    }
  }
  .content {
    flex: 1;
    min-width: 0;
    padding: 0 12px 0 ${props => props.$numbers ? 0 : 8}px;
    white-space: ${props => props.$wrap ? 'pre-wrap' : 'pre'};
    overflow-wrap: ${props => props.$wrap ? 'anywhere' : 'normal'};
  }
`

const Placeholder = styled.div`
  padding: 8px 12px;
  .${Classes.SKELETON} {
    height: 12px;
    margin: 3px 0;
  }
`

const LatestButton = styled.div`
  position: absolute;
  right: 16px;
  bottom: 12px;
  z-index: 1;
`

const LiveDot = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${Colors.GREEN4};
  animation: qa-log-pulse 1.6s ease-in-out infinite;
  @keyframes qa-log-pulse {
    0% { box-shadow: 0 0 0 0 rgba(50, 164, 103, 0.6); }
    70% { box-shadow: 0 0 0 6px rgba(50, 164, 103, 0); }
    100% { box-shadow: 0 0 0 0 rgba(50, 164, 103, 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`


const LogLine = memo(({ index, number, html, level, match, current }) => {
  const className = ['line', level, match && 'match', current && 'current'].filter(Boolean).join(' ')
  return <div className={className} data-index={index}>
    {number !== null && <span className="number">{number}</span>}
    <span className="content" dangerouslySetInnerHTML={{ __html: html }} />
  </div>
})


const Skeleton = () => <Placeholder>
  {[72, 45, 88, 60, 30].map((width, index) => <div key={index} className={Classes.SKELETON} style={{ width: `${width}%` }} />)}
</Placeholder>


/**
 * Shows a log file, with colors, line numbers, search, errors... While `live`, follows the file as it's written.
 * `files` are the logs the user can switch between: [{name: "log.txt", url: "/s/..."}]
 * `emptyHint` explains missing files ({"log.lsf.txt": "..."}), `waitingHint` why live logs don't exist yet.
 */
export const LogViewer = ({ files, file, onFileChange, live = false, emptyHint, waitingHint }) => {
  const selected = files.find(f => f.name === file) ?? files[0]
  const url = selected?.url
  const log = useLogTail(url, { live })

  const [wrap, setWrap] = usePersistentState('qaboard.logs.wrap', true)
  const [tall, setTall] = useState(false)
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  // which match is selected, for which search
  const [selection, setSelection] = useState({ query: '', index: 0 })
  const [current_error, setCurrentError] = useState(-1)
  // the line we jumped to
  const [focused_line, setFocusedLine] = useState(null)
  const body = useRef(null)
  const search_input = useRef(null)

  // Lines
  // a new parser for each file
  const parser = useMemo(() => url && createLineParser(), [url])
  const all_lines = useMemo(() => parser ? parser(log.text) : [], [parser, log.text])
  const hidden = Math.max(0, all_lines.length - MAX_LINES)
  const lines = useMemo(() => hidden ? all_lines.slice(hidden) : all_lines, [all_lines, hidden])
  // Without the start of the file, we don't know the line numbers
  const has_numbers = log.start === 0
  const digits = String(hidden + lines.length).length
  const error_lines = useMemo(() => lines.reduce((errors, line, index) => {
    if (line.level === 'error') errors.push(index)
    return errors
  }, []), [lines])

  // Search
  const deferred_query = useDeferredValue(query)
  const matches = useMemo(() => {
    const needle = deferred_query.toLowerCase()
    if (!needle) return []
    const found = []
    for (let index = 0; index < lines.length && found.length < MAX_MATCHES; index++) {
      const haystack = lines[index].plain.toLowerCase()
      for (let start = haystack.indexOf(needle); start >= 0 && found.length < MAX_MATCHES; start = haystack.indexOf(needle, start + needle.length))
        found.push({ line: index, start, end: start + needle.length })
    }
    return found
  }, [lines, deferred_query])
  const matching_lines = useMemo(() => new Set(matches.map(m => m.line)), [matches])
  const current_match = selection.query === query ? Math.min(selection.index, Math.max(0, matches.length - 1)) : 0
  // While the search is computed, matches are for the previous query
  const current = matches.length && query === deferred_query ? matches[current_match] : null

  const scrollToLine = useCallback(index => {
    const element = body.current?.querySelector(`[data-index="${index}"]`)
    if (!element) return
    setFollow(false)
    body.current.scrollTop = element.offsetTop - body.current.clientHeight / 2
  }, [])

  useEffect(() => {
    if (current) scrollToLine(current.line)
  }, [current, scrollToLine])

  const nextMatch = step => {
    if (!matches.length) return
    setFocusedLine(null)
    setSelection({ query, index: (current_match + step + matches.length) % matches.length })
  }

  const nextError = () => {
    if (!error_lines.length) return
    const next = (current_error + 1) % error_lines.length
    setCurrentError(next)
    setFocusedLine(error_lines[next])
    scrollToLine(error_lines[next])
  }

  // Exact highlights of the matches
  useEffect(() => {
    if (!supportsHighlights() || !body.current) return
    const elements = body.current.querySelectorAll('.line .content')
    const ranges = []
    const current_ranges = []
    for (const match of matches) {
      const element = elements[match.line]
      const range = element && textRange(element, match.start, match.end)
      if (!range) continue
      ranges.push(range)
      if (match === current) current_ranges.push(range)
    }
    const highlight = getHighlight('qa-log-match')
    const current_highlight = getHighlight('qa-log-current')
    ranges.forEach(range => highlight.add(range))
    current_ranges.forEach(range => current_highlight.add(range))
    return () => {
      ranges.forEach(range => highlight.delete(range))
      current_ranges.forEach(range => current_highlight.delete(range))
    }
  }, [matches, current, lines, wrap])

  // Follow the end of the logs, like a terminal, until users scroll up
  useLayoutEffect(() => {
    if (follow && body.current)
      body.current.scrollTop = body.current.scrollHeight
  }, [lines, follow, tall])

  const onScroll = event => {
    const element = event.currentTarget
    const at_bottom = element.scrollHeight - element.scrollTop - element.clientHeight < LINE_HEIGHT
    if (at_bottom !== follow) setFollow(at_bottom)
  }

  const onKeyDown = event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault()
      search_input.current?.focus()
      search_input.current?.select()
    }
  }

  const onSearchKeyDown = event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      nextMatch(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      setQuery('')
    }
  }

  const copy = () => {
    const text = all_lines.map(line => line.plain).join('\n')
    navigator.clipboard?.writeText(text).then(
      () => toaster.show({ message: `Copied ${all_lines.length.toLocaleString()} lines`, icon: 'tick', intent: Intent.SUCCESS, timeout: 2000 }),
      () => toaster.show({ message: 'Could not copy the logs', intent: Intent.DANGER }),
    )
  }

  const is_missing = log.status === 'error' && log.error?.status === 404
  const is_loading = log.status === 'loading' || (log.status === 'idle' && !!url)

  let content
  if (log.status === 'error') {
    content = <NonIdealState
      icon={is_missing && live ? <Spinner size={20} /> : (is_missing ? "document" : "error")}
      iconSize={is_missing && live ? undefined : 32}
      title={is_missing ? `No ${selected.name} yet` : `Could not read ${selected.name}`}
      description={is_missing
        ? (live ? (waitingHint ?? "The run hasn't written it yet, we'll show it as soon as it does.") : (emptyHint?.[selected.name] ?? "This file doesn't exist."))
        : log.error?.message}
      action={!is_missing && <Button icon="refresh" text="Retry" onClick={log.reload} />}
      layout="horizontal"
    />
  } else if (is_loading && !log.text) {
    content = <Skeleton />
  } else if (!lines.length) {
    content = <div className={Classes.TEXT_MUTED} style={{ padding: '8px 12px' }}>
      {live ? <><Spinner size={12} style={{ display: 'inline-block', marginRight: 8 }} />Waiting for output…</> : 'Empty.'}
    </div>
  } else {
    content = lines.map((line, index) => <LogLine
      key={index}
      index={index}
      number={has_numbers ? hidden + index + 1 : null}
      html={line.html}
      level={line.level}
      match={matching_lines.has(index)}
      current={current ? current.line === index : focused_line === index}
    />)
  }

  const truncated_bytes = log.status === 'loaded' && log.start > 0
  return <Frame onKeyDown={onKeyDown}>
    <HighlightStyles />
    <Toolbar>
      {files.length > 1
        ? <SegmentedControl
            size="small"
            value={selected.name}
            onValueChange={onFileChange}
            options={files.map(f => ({ label: f.name, value: f.name }))}
          />
        : <Tag minimal icon="document">{selected?.name}</Tag>
      }
      {live && <Tooltip content="The run is still running, the logs update as it writes them.">
        <Tag minimal round icon={<LiveDot />} style={{ marginLeft: 2 }}>Live</Tag>
      </Tooltip>}
      {log.total !== null && <span className={`meta ${Classes.TEXT_MUTED}`}>
        {has_numbers && `${(hidden + lines.length).toLocaleString()} lines · `}{formatBytes(log.total)}
      </span>}
      <div className="spacer" />
      {error_lines.length > 0 && <Tooltip content="Jump to the next error">
        <Button size="small" variant="minimal" intent={Intent.DANGER} icon="error" onClick={nextError}>
          {current_error >= 0 ? `${current_error + 1}/` : ''}{error_lines.length.toLocaleString()} error{error_lines.length > 1 ? 's' : ''}
        </Button>
      </Tooltip>}
      <InputGroup
        className="search"
        size="small"
        leftIcon="search"
        placeholder="Search…"
        value={query}
        inputRef={search_input}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={onSearchKeyDown}
        rightElement={query ? <span style={{ display: 'flex', alignItems: 'center' }}>
          <span className={`search-count ${Classes.TEXT_MUTED}`}>
            {matches.length ? `${current_match + 1}/${matches.length >= MAX_MATCHES ? `${MAX_MATCHES}+` : matches.length}` : '0/0'}
          </span>
          <Button size="small" variant="minimal" icon="chevron-up" aria-label="Previous match" disabled={!matches.length} onClick={() => nextMatch(-1)} />
          <Button size="small" variant="minimal" icon="chevron-down" aria-label="Next match" disabled={!matches.length} onClick={() => nextMatch(1)} />
        </span> : undefined}
      />
      <ButtonGroup variant="minimal">
        <Tooltip content={wrap ? "Don't wrap lines" : "Wrap lines"}>
          <Button size="small" icon="wrap-lines" active={wrap} aria-label="Wrap lines" onClick={() => setWrap(!wrap)} />
        </Tooltip>
        <Tooltip content={tall ? "Smaller" : "Taller"}>
          <Button size="small" icon={tall ? "minimize" : "maximize"} aria-label={tall ? "Smaller" : "Taller"} onClick={() => setTall(!tall)} />
        </Tooltip>
        <Tooltip content="Copy the logs">
          <Button size="small" icon="duplicate" aria-label="Copy the logs" disabled={!lines.length} onClick={copy} />
        </Tooltip>
        <Tooltip content="Download">
          <AnchorButton size="small" icon="download" aria-label="Download" href={url} download={selected?.name} />
        </Tooltip>
        <Tooltip content="Open the raw file">
          <AnchorButton size="small" icon="share" aria-label="Open the raw file" href={url} target="_blank" rel="noopener noreferrer" />
        </Tooltip>
      </ButtonGroup>
    </Toolbar>
    {truncated_bytes && <Notice className={Classes.TEXT_MUTED}>
      Showing the last {formatBytes(log.end - log.start)} of {formatBytes(log.total)}.
      <Button size="small" variant="minimal" intent={Intent.PRIMARY} onClick={log.loadAll} loading={is_loading}>Load everything</Button>
    </Notice>}
    {hidden > 0 && <Notice className={Classes.TEXT_MUTED}>
      Showing the last {MAX_LINES.toLocaleString()} lines. Download the file to see everything.
    </Notice>}
    <Body
      ref={body}
      className={Classes.MONOSPACE_TEXT}
      tabIndex={0}
      onScroll={onScroll}
      $wrap={wrap}
      $tall={tall}
      $digits={digits}
      $numbers={has_numbers}
      $highlights={supportsHighlights()}
    >
      {content}
    </Body>
    {!follow && lines.length > 0 && <LatestButton>
      <Button size="small" icon="arrow-down" intent={live ? Intent.PRIMARY : Intent.NONE} onClick={() => setFollow(true)}>
        {live ? 'Follow' : 'Bottom'}
      </Button>
    </LatestButton>}
  </Frame>
}
