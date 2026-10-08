// Browse the files nginx serves under /s/, see services/nginx/snippets/qaboard-files.conf
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import copy from "copy-to-clipboard";
import {
  Alert,
  AnchorButton,
  Button,
  ButtonGroup,
  Callout,
  Checkbox,
  Classes,
  Dialog,
  DialogBody,
  FormGroup,
  InputGroup,
  Intent,
  NonIdealState,
  Spinner,
  SpinnerSize,
  Tag,
  Tooltip,
  useHotkeys,
} from "@blueprintjs/core";
import {
  AlignLeftIcon, ArrowUpIcon, ChevronRightIcon, ClipboardIcon, CodeIcon, CompressedIcon, ConsoleIcon, CrossIcon, CubeIcon,
  DisableIcon, DocumentIcon, DownloadIcon, DuplicateIcon, ErrorIcon, EyeOffIcon, EyeOpenIcon, FolderCloseIcon,
  FolderSharedIcon, HelpIcon, HomeIcon, LockIcon, LogInIcon, LogOutIcon, MediaIcon, NumericalIcon,
  RedoIcon, RefreshIcon, SearchIcon, ShareIcon, StopIcon, ThIcon, TimelineLineChartIcon, TrashIcon, VideoIcon,
  WarningSignIcon,
} from "@blueprintjs/icons";

import { toaster } from "../toaster";
import { setPathMappings, hasPathMappings } from "../utils/paths";
import { fetchAccess, fetchJson, fetchListing, fetchRun, runAction, signIn, signOut } from "./api";
import {
  baseName, breadcrumbs, filterEntries, formatAbsoluteTime, formatRelativeTime, formatSize, formatSummary, iconName,
  joinPath, linuxPath, parentPath, parseLocation, pathFromUrl, sortEntries, summarize, urlFromPath, windowsPath,
} from "./logic";


const ICONS = {
  'align-left': AlignLeftIcon, code: CodeIcon, compressed: CompressedIcon, console: ConsoleIcon, cube: CubeIcon,
  document: DocumentIcon, error: ErrorIcon, 'folder-close': FolderCloseIcon, 'folder-shared': FolderSharedIcon,
  help: HelpIcon, media: MediaIcon, numerical: NumericalIcon, th: ThIcon, 'timeline-line-chart': TimelineLineChartIcon,
  video: VideoIcon,
}

const ROW_HEIGHT = 28
// The header, toolbar and columns' names stay at the top of the screen, see files.css
const STICKY_HEIGHT = 44 + 40 + 30
// Above this, we only render the rows on screen. Below, the browser's Ctrl+F still finds everything.
const WINDOWING_THRESHOLD = 300
const PREFETCH_DELAY = 150 // ms hovering a folder before we fetch its content
const REVALIDATE_AFTER = 5000 // ms, cached listings are shown at once, but refreshed if older

const loadPreferences = () => {
  try {
    return JSON.parse(localStorage.getItem('qaboard-files') ?? '{}')
  } catch {
    return {}
  }
}
const savePreferences = preferences => {
  try {
    localStorage.setItem('qaboard-files', JSON.stringify(preferences))
  } catch {
    // e.g. private browsing
  }
}

// The path from the page's URL. The dev server serves this page at /files.html?path=...
const currentPath = () => {
  const { pathname, search } = window.location
  if (pathname.endsWith('/files.html'))
    return new URLSearchParams(search).get('path') || '/'
  return pathFromUrl(pathname)
}

const copyToClipboard = (text, what) => {
  copy(text)
  toaster.show({ message: <span>Copied {what}: <code className="fb-copied">{text}</code></span>, intent: Intent.SUCCESS, timeout: 2500, icon: <ClipboardIcon/> }, 'copied')
}

const isPlainLeftClick = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey


export default function FileBrowser() {
  const [path, setPath] = useState(currentPath)
  const [listingState, setListing] = useState({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [preferences, setPreferences] = useState(() => ({ sort: { key: 'name', desc: false }, showHidden: false, ...loadPreferences() }))
  const [selected, setSelected] = useState(-1)
  const [editingPath, setEditingPath] = useState(false)
  const [config, setConfig] = useState({})
  const [user, setUser] = useState(null)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [reloads, setReloads] = useState(0) // the refresh button, "r", after signing in...

  const cache = useRef(new Map())
  const inflight = useRef(new Map())
  const filterRef = useRef(null)
  const focusName = useRef(null) // the row to select once the listing is loaded, e.g. the folder we come from
  const restoreScroll = useRef(null)

  const isFolder = path.endsWith('/')

  // The run this folder belongs to, if any: users can redo or delete it from here
  const [run, setRun] = useState(null)
  const [runReloads, setRunReloads] = useState(0)
  useEffect(() => {
    if (!isFolder) return
    const controller = new AbortController()
    fetchRun(path, { signal: controller.signal }).then(setRun).catch(() => {})
    return () => controller.abort()
  }, [path, isFolder, runReloads])
  // Don't show the previous folder's run while we look for this one's
  const currentRun = run && (path === `${run.folder}/` || path.startsWith(`${run.folder}/`)) ? run : null

  const updatePreferences = update => setPreferences(previous => {
    const preferences = { ...previous, ...update }
    savePreferences(preferences)
    return preferences
  })

  // The site's configuration (Windows paths, how users sign in) and who the user is
  const loadUser = useCallback(() => fetchJson('/api/v1/user/me/').then(setUser).catch(() => setUser(null)), [])
  useEffect(() => {
    fetchJson('/api/v1/config').then(config => {
      setPathMappings(config.path_mappings)
      setConfig(config)
    }).catch(() => {})
    loadUser()
  }, [loadUser])

  // Folders' content: cached, requests deduplicated
  const getListing = useCallback(folder => {
    if (inflight.current.has(folder)) return inflight.current.get(folder)
    const request = fetchListing(folder)
      .then(data => {
        cache.current.set(folder, { data, time: Date.now() })
        return data
      })
      .finally(() => inflight.current.delete(folder))
    inflight.current.set(folder, request)
    return request
  }, [])

  useEffect(() => {
    if (!path.endsWith('/')) return
    let cancelled = false
    const cached = cache.current.get(path)
    if (cached) {
      setListing({ status: 'ok', path, data: cached.data })
      if (Date.now() - cached.time < REVALIDATE_AFTER) return
    } else {
      // When refreshing, we keep showing the folder's content
      setListing(listing => listing.status === 'ok' && listing.path === path ? listing : { status: 'loading', path })
    }
    getListing(path)
      .then(data => !cancelled && setListing({ status: 'ok', path, data }))
      .catch(error => {
        if (cancelled) return
        cache.current.delete(path)
        setListing({ status: 'error', path, error })
      })
    return () => { cancelled = true }
  }, [path, reloads, getListing])

  useEffect(() => {
    document.title = `${baseName(path) || '/'} · QA-Board`
  }, [path])

  // Navigation without reloading the page
  const navigate = useCallback((to, { focus = null } = {}) => {
    // to restore the scroll position when users come back
    window.history.replaceState({ ...window.history.state, scrollY: window.scrollY }, '')
    window.history.pushState({}, '', urlFromPath(to))
    focusName.current = focus
    restoreScroll.current = 0
    setQuery('')
    setSelected(-1)
    setEditingPath(false)
    setPath(to)
  }, [])

  useEffect(() => {
    const onPopState = event => {
      focusName.current = null
      restoreScroll.current = event.state?.scrollY ?? 0
      setQuery('')
      setSelected(-1)
      setPath(currentPath())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const goUp = useCallback(() => {
    const parent = parentPath(path)
    if (parent) navigate(parent, { focus: baseName(path) })
  }, [path, navigate])

  // What we show. Right after navigating, until the effect above runs, the listing is still the previous folder's
  const listing = useMemo(() => listingState.path === path ? listingState : { status: 'loading', path }, [listingState, path])
  const entries = useMemo(() => {
    if (listing.status !== 'ok') return []
    return sortEntries(filterEntries(listing.data.entries, { query, showHidden: preferences.showHidden }), preferences.sort)
  }, [listing, query, preferences.showHidden, preferences.sort])
  const hiddenCount = useMemo(() => listing.status === 'ok' ? listing.data.entries.filter(e => e.name.startsWith('.')).length : 0, [listing])

  // Once loaded: select the folder we come from, or restore the scroll position
  useLayoutEffect(() => {
    if (listing.status !== 'ok') return
    if (focusName.current !== null) {
      const index = entries.findIndex(e => e.name === focusName.current)
      focusName.current = null
      if (index >= 0) setSelected(index)
    }
    if (restoreScroll.current !== null) {
      window.scrollTo(0, restoreScroll.current)
      restoreScroll.current = null
    }
  }, [listing, entries])

  const open = useCallback((entry, event) => {
    const target = joinPath(path, entry.name)
    if (entry.type === 'directory') {
      if (event && !isPlainLeftClick(event)) return // new tab...
      event?.preventDefault()
      navigate(`${target}/`)
    } else if (!event) {
      window.location.href = urlFromPath(target)
    }
  }, [path, navigate])

  // Prefetch folders when users hover them
  const prefetchTimer = useRef(null)
  const prefetch = useCallback(entry => {
    clearTimeout(prefetchTimer.current)
    if (!entry || entry.type !== 'directory') return
    const folder = `${joinPath(path, entry.name)}/`
    prefetchTimer.current = setTimeout(() => {
      if (!cache.current.has(folder)) getListing(folder).catch(() => {})
    }, PREFETCH_DELAY)
  }, [path, getListing])

  const copyPath = useCallback((target, windows = false) => {
    if (windows) copyToClipboard(windowsPath(target), 'the Windows path')
    else copyToClipboard(linuxPath(target), 'the path')
  }, [])

  // Keyboard shortcuts, "?" lists them
  const state = useRef({})
  useLayoutEffect(() => {
    state.current = { entries, selected, path, open, goUp, copyPath }
  })
  const move = delta => setSelected(index => {
    const count = state.current.entries.length
    if (!count) return -1
    return Math.max(0, Math.min(count - 1, index < 0 ? (delta > 0 ? 0 : count - 1) : index + delta))
  })
  const selectedPath = () => {
    const { entries, selected, path } = state.current
    const entry = entries[selected]
    return entry ? joinPath(path, entry.name) : path
  }
  const hotkeys = useMemo(() => [
    { combo: '/', global: true, group: 'Files', label: 'Filter', preventDefault: true, onKeyDown: () => filterRef.current?.focus() },
    { combo: 'g', global: true, group: 'Files', label: 'Go to a path (Linux, Windows or URL)', preventDefault: true, onKeyDown: () => setEditingPath(true) },
    { combo: 'j', global: true, group: 'Files', label: 'Next', onKeyDown: () => move(1) },
    { combo: 'down', global: true, group: 'Files', label: 'Next', preventDefault: true, onKeyDown: () => move(1) },
    { combo: 'k', global: true, group: 'Files', label: 'Previous', onKeyDown: () => move(-1) },
    { combo: 'up', global: true, group: 'Files', label: 'Previous', preventDefault: true, onKeyDown: () => move(-1) },
    { combo: 'enter', global: true, group: 'Files', label: 'Open', onKeyDown: event => {
      // Links and buttons handle "enter" themselves
      if (event.target.closest?.('a,button')) return
      const { entries, selected, open } = state.current
      if (entries[selected]) open(entries[selected])
    } },
    { combo: 'right', global: true, group: 'Files', label: 'Open', onKeyDown: () => {
      const { entries, selected, open } = state.current
      if (entries[selected]?.type === 'directory') open(entries[selected])
    } },
    { combo: 'backspace', global: true, group: 'Files', label: 'Parent folder', preventDefault: true, onKeyDown: () => state.current.goUp() },
    { combo: 'left', global: true, group: 'Files', label: 'Parent folder', onKeyDown: () => state.current.goUp() },
    { combo: 'c', global: true, group: 'Files', label: 'Copy the path (selected file, or the folder)', onKeyDown: () => state.current.copyPath(selectedPath()) },
    { combo: 'w', global: true, group: 'Files', label: 'Copy the Windows path', onKeyDown: () => state.current.copyPath(selectedPath(), true) },
    { combo: '.', global: true, group: 'Files', label: 'Show/hide hidden files', onKeyDown: () => setPreferences(p => {
      const preferences = { ...p, showHidden: !p.showHidden }
      savePreferences(preferences)
      return preferences
    }) },
    { combo: 'r', global: true, group: 'Files', label: 'Refresh', onKeyDown: () => {
      cache.current.delete(state.current.path)
      setReloads(n => n + 1)
    } },
  ], [])
  useHotkeys(hotkeys)

  const refresh = () => {
    cache.current.delete(path)
    setReloads(n => n + 1)
  }

  const onSignedIn = () => {
    setIsSigningIn(false)
    cache.current.clear()
    loadUser()
    if (isFolder) setReloads(n => n + 1)
    else window.location.reload()
  }
  const requestSignIn = () => {
    if (config.login_type === 'SAML')
      window.location.href = '/api/auth/saml20/login/?sso'
    else
      setIsSigningIn(true)
  }
  const onSignOut = async () => {
    if (config.login_type === 'SAML') {
      window.location.href = '/api/auth/saml20/login/?slo'
      return
    }
    await signOut()
    cache.current.clear()
    setUser(null)
    loadUser()
    setReloads(n => n + 1)
  }

  return <div className="fb-page">
    <header className={`fb-header ${Classes.DARK}`}>
      <div className="fb-header-row">
        <a className="fb-brand" href="/" title="QA-Board's home">QA-Board</a>
        <PathBar
          path={path}
          editing={editingPath}
          setEditing={setEditingPath}
          navigate={navigate}
        />
        <ButtonGroup className="fb-path-actions">
          <Tooltip content={<span>Copy the path <kbd className="fb-kbd">c</kbd></span>} placement="bottom">
            <Button size="small" variant="minimal" icon={<DuplicateIcon/>} text="Copy path" onClick={() => copyPath(path)}/>
          </Tooltip>
          {hasPathMappings() && <Tooltip content={<span>Copy the Windows path <kbd className="fb-kbd">w</kbd></span>} placement="bottom">
            <Button size="small" variant="minimal" text="Windows" onClick={() => copyPath(path, true)}/>
          </Tooltip>}
        </ButtonGroup>
        <UserMenu user={user} onSignIn={requestSignIn} onSignOut={onSignOut}/>
      </div>
    </header>

    {isFolder
      ? <main className="fb-main">
          {currentRun && <RunBar
            run={currentRun}
            path={path}
            user={user}
            navigate={navigate}
            onSignIn={requestSignIn}
            onDone={action => {
              setRunReloads(n => n + 1)
              if (action === 'delete') {
                // The run's folder is gone
                cache.current.clear()
                navigate(parentPath(`${currentRun.folder}/`) ?? '/', { focus: baseName(currentRun.folder) })
              } else if (action === 'delete-files') {
                refresh()
              }
            }}
          />}
          <Toolbar
            filterRef={filterRef}
            query={query}
            setQuery={q => { setQuery(q); setSelected(q ? 0 : -1) }}
            showHidden={preferences.showHidden}
            hiddenCount={hiddenCount}
            toggleHidden={() => updatePreferences({ showHidden: !preferences.showHidden })}
            refresh={refresh}
            goUp={path !== '/' ? goUp : null}
            listing={listing}
            shown={entries}
            onFilterKeyDown={event => {
              if (event.key === 'Escape') {
                setQuery('')
                event.currentTarget.blur()
              } else if (event.key === 'Enter' && entries.length) {
                open(entries[Math.max(0, selected)])
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                event.currentTarget.blur()
                move(1)
              }
            }}
          />
          {listing.status === 'loading' && <div className="fb-loading"><Spinner size={SpinnerSize.SMALL}/></div>}
          {listing.status === 'error' && <ErrorState error={listing.error} path={path} user={user} navigate={navigate} onSignIn={requestSignIn} retry={refresh} support_url={config.support_url}/>}
          {listing.status === 'ok' && <>
            {listing.data.truncated && <Callout intent={Intent.WARNING} icon={<WarningSignIcon/>} className="fb-callout" compact>
              This folder is huge: we only show its first {listing.data.entries.length.toLocaleString()} entries. Filter them, or use a shell.
            </Callout>}
            <FileTable
              path={path}
              entries={entries}
              sort={preferences.sort}
              setSort={sort => updatePreferences({ sort })}
              selected={selected}
              setSelected={setSelected}
              open={open}
              prefetch={prefetch}
              copyPath={copyPath}
              empty={listing.data.entries.length === 0
                ? <NonIdealState icon={<FolderCloseIcon size={48}/>} title="This folder is empty"/>
                : <NonIdealState icon={<SearchIcon size={48}/>} title="Nothing matches"
                    description={query ? <span>No file matches <code>{query}</code>{!preferences.showHidden && hiddenCount > 0 && ' (hidden files included)'}.</span> : `${hiddenCount} hidden files.`}
                    action={query ? <Button text="Clear the filter" onClick={() => setQuery('')}/> : <Button text="Show hidden files" onClick={() => updatePreferences({ showHidden: true })}/>}
                  />}
            />
          </>}
        </main>
      : <main className="fb-main">
          <FileAccess path={path} user={user} navigate={navigate} onSignIn={requestSignIn} support_url={config.support_url}/>
        </main>
    }

    <footer className={`fb-footer ${Classes.TEXT_MUTED}`}>
      <span><kbd className="fb-kbd">?</kbd> keyboard shortcuts</span>
      {isFolder && <a href={`${urlFromPath(path)}?view=nginx`}>Plain index</a>}
      {config.docs_root && <a href={`${config.docs_root}docs/user-guide/files`} target="_blank" rel="noopener noreferrer">Help</a>}
    </footer>

    <SignInDialog isOpen={isSigningIn} onClose={() => setIsSigningIn(false)} onSignedIn={onSignedIn}/>
  </div>
}


const RUN_ACTIONS = {
  redo: {
    icon: <RedoIcon/>, text: 'Redo', intent: Intent.WARNING, done: 'Redo started',
    confirm: 'Run it again? Its current files are replaced when it starts.',
  },
  'mark-failed': {
    icon: <StopIcon/>, text: 'Mark as failed', intent: Intent.WARNING, done: 'Marked as failed',
    title: "For runs stuck as pending or running: their job is gone and will never report",
  },
  delete: {
    icon: <TrashIcon/>, text: 'Delete…', intent: Intent.DANGER, done: 'Deleted',
    confirm: 'Delete this run? Its folder and its results in QA-Board are deleted.',
  },
}

// The run whose output folder we're in: its status, a link to its results, and what users can do with it.
// Like in the web app, we act on whole runs, never on single files.
function RunBar({ run, path, user, navigate, onSignIn, onDone }) {
  const [confirming, setConfirming] = useState(null)
  const [onlyFiles, setOnlyFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const signedIn = !!user?.is_authenticated
  const status = run.deleted ? ['Deleted', Intent.NONE]
    : run.is_failed ? ['Failed', Intent.DANGER]
    : run.is_running ? ['Running', Intent.PRIMARY]
    : run.is_pending ? ['Pending', Intent.WARNING]
    : ['Done', Intent.SUCCESS]
  const actions = run.is_pending ? ['mark-failed', 'delete'] : run.deleted ? ['redo'] : ['redo', 'delete']

  const execute = async name => {
    const action = name === 'delete' && onlyFiles ? 'delete-files' : name
    setConfirming(null)
    setBusy(true)
    try {
      await runAction(action, run.id)
      toaster.show({ message: RUN_ACTIONS[name].done, intent: Intent.SUCCESS, icon: RUN_ACTIONS[name].icon })
      onDone(action)
    } catch (error) {
      if (error.status === 401) onSignIn()
      toaster.show({ message: error.message ?? `Failed (HTTP ${error.status})`, intent: Intent.DANGER, icon: <ErrorIcon/> })
    } finally {
      setBusy(false)
    }
  }
  const request = name => {
    if (!signedIn) return onSignIn()
    if (RUN_ACTIONS[name].confirm) setConfirming(name)
    else execute(name)
  }

  const runFolder = `${run.folder}/`
  return <section className="fb-run" aria-label="Run">
    <Tag intent={status[1]} minimal={status[1] === Intent.NONE}>{status[0]}</Tag>
    <span className="fb-run-what" title={[run.input, ...(run.configurations ?? []).map(c => typeof c === 'string' ? c : JSON.stringify(c))].join('\n')}>
      {path === runFolder
        ? <>Run on <code>{run.input}</code></>
        : <>In the run on <a href={urlFromPath(runFolder)} onClick={event => {
            if (!isPlainLeftClick(event)) return
            event.preventDefault()
            navigate(runFolder)
          }}><code>{run.input}</code></a></>}
      <span className="fb-run-detail">
        {run.batch !== 'default' && <>batch {run.batch} · </>}{run.platform}{run.user && <> · by {run.user}</>}
      </span>
    </span>
    <span className="fb-run-actions">
      <AnchorButton size="small" variant="minimal" icon={<ShareIcon/>} text="Results" href={run.url} target="_blank" rel="noopener noreferrer"
        title="Open the run's results and logs in QA-Board"/>
      {actions.map(name => <Tooltip key={name} content={signedIn ? RUN_ACTIONS[name].title : 'Sign in to change runs'} disabled={signedIn && !RUN_ACTIONS[name].title} placement="bottom">
        <Button size="small" variant="minimal" icon={RUN_ACTIONS[name].icon} text={RUN_ACTIONS[name].text}
          intent={RUN_ACTIONS[name].intent} disabled={busy} onClick={() => request(name)}/>
      </Tooltip>)}
    </span>
    <Alert
      isOpen={confirming !== null}
      icon={confirming ? RUN_ACTIONS[confirming].icon : undefined}
      intent={confirming ? RUN_ACTIONS[confirming].intent : undefined}
      confirmButtonText={confirming === 'delete' && onlyFiles ? 'Delete its files' : confirming ? RUN_ACTIONS[confirming].text.replace('…', '') : ''}
      cancelButtonText="Cancel"
      canEscapeKeyCancel
      canOutsideClickCancel
      onConfirm={() => execute(confirming)}
      onCancel={() => setConfirming(null)}
    >
      <p>{confirming && RUN_ACTIONS[confirming].confirm}</p>
      <p><code>{run.folder}</code></p>
      {confirming === 'delete' && <Checkbox checked={onlyFiles} onChange={event => setOnlyFiles(event.target.checked)}
        label="Only delete its files, keep the run in QA-Board"/>}
    </Alert>
  </section>
}


// Breadcrumbs. Click next to them, or press "g", to type or paste a path
function PathBar({ path, editing, setEditing, navigate }) {
  // Long paths: we show their end, also when the header's other buttons appear
  const navRef = useRef(null)
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const scrollToEnd = () => { nav.scrollLeft = nav.scrollWidth }
    scrollToEnd()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(scrollToEnd)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [path, editing])

  if (editing)
    return <PathInput path={path} close={() => setEditing(false)} navigate={navigate}/>

  const crumbs = breadcrumbs(path)
  return <nav ref={navRef} className="fb-pathbar" aria-label="Path">
    {crumbs.map((crumb, index) => {
      const isLast = index === crumbs.length - 1 && path.endsWith('/')
      return <span key={crumb.path} className="fb-crumb">
        {index > 1 && <ChevronRightIcon size={12} className="fb-crumb-separator"/>}
        {isLast
          ? <span className="fb-crumb-current">{crumb.name}</span>
          : <a href={urlFromPath(crumb.path)} onClick={event => {
              if (!isPlainLeftClick(event)) return
              event.preventDefault()
              navigate(crumb.path, { focus: crumbs[index + 1]?.name })
            }}>{index === 0 ? <HomeIcon size={12} title="/"/> : crumb.name}</a>}
      </span>
    })}
    <button className="fb-pathbar-edit" onClick={() => setEditing(true)} title="Type or paste a path (g)" aria-label="Type or paste a path"/>
  </nav>
}


function PathInput({ path, close, navigate }) {
  const [value, setValue] = useState(() => linuxPath(path))
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  useEffect(() => inputRef.current?.focus(), [])
  const submit = event => {
    event.preventDefault()
    const target = parseLocation(value)
    if (!target) {
      setError(value.includes('\\') ? "We don't know where this Windows path is on Linux." : 'Enter a path like /algo/project, a Windows path, or a QA-Board URL.')
      return
    }
    // Files probably have an extension. If we're wrong about a folder, nginx adds the trailing slash
    if (target.endsWith('/') || !/\.[^/]+$/.test(target)) navigate(target.endsWith('/') ? target : `${target}/`)
    else window.location.href = urlFromPath(target)
  }
  return <form className="fb-pathbar fb-pathbar-editing" onSubmit={submit}>
    <InputGroup
      inputRef={inputRef}
      fill
      size="small"
      value={value}
      onChange={event => { setValue(event.target.value); setError(null) }}
      onFocus={event => event.target.select()}
      onBlur={close}
      onKeyDown={event => event.key === 'Escape' && close()}
      intent={error ? Intent.DANGER : Intent.NONE}
      aria-label="Go to a path"
      placeholder={"/algo/project, \\\\server\\share\\folder or a URL"}
      rightElement={error ? <Tooltip content={error} isOpen placement="bottom"><WarningSignIcon className="fb-input-icon"/></Tooltip> : undefined}
    />
  </form>
}

function UserMenu({ user, onSignIn, onSignOut }) {
  if (user === null) return null
  if (!user.is_authenticated)
    return <Button className="fb-user" size="small" variant="minimal" icon={<LogInIcon/>} text="Sign in" onClick={onSignIn}/>
  return <span className="fb-user">
    <span className="fb-user-name" title={user.email ?? undefined}>{user.full_name || user.user_name}</span>
    <Tooltip content="Sign out" placement="bottom">
      <Button size="small" variant="minimal" icon={<LogOutIcon/>} aria-label="Sign out" onClick={onSignOut}/>
    </Tooltip>
  </span>
}


function Toolbar({ filterRef, query, setQuery, onFilterKeyDown, showHidden, hiddenCount, toggleHidden, refresh, goUp, listing, shown }) {
  const total = listing.status === 'ok' ? listing.data.entries : []
  const summary = useMemo(() => formatSummary(summarize(shown)), [shown])
  return <div className="fb-toolbar">
    <Tooltip content={<span>Parent folder <kbd className="fb-kbd">⌫</kbd></span>} placement="bottom" disabled={!goUp}>
      <Button size="small" icon={<ArrowUpIcon/>} aria-label="Parent folder" disabled={!goUp} onClick={() => goUp?.()}/>
    </Tooltip>
    <InputGroup
      inputRef={filterRef}
      className="fb-filter"
      size="small"
      leftIcon={<SearchIcon/>}
      placeholder="Filter, e.g. log or *.png"
      value={query}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={onFilterKeyDown}
      aria-label="Filter"
      rightElement={query ? <Button variant="minimal" size="small" icon={<CrossIcon/>} aria-label="Clear the filter" onClick={() => setQuery('')}/> : <kbd className="fb-kbd fb-filter-hint">/</kbd>}
    />
    <Tooltip content={<span>{showHidden ? 'Hide' : 'Show'} hidden files <kbd className="fb-kbd">.</kbd></span>} placement="bottom">
      <Button className="fb-hidden-count" size="small" variant="minimal" icon={showHidden ? <EyeOpenIcon/> : <EyeOffIcon/>} active={showHidden} onClick={toggleHidden}
        text={hiddenCount > 0 ? `${hiddenCount} hidden` : undefined} aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}/>
    </Tooltip>
    <Tooltip content={<span>Refresh <kbd className="fb-kbd">r</kbd></span>} placement="bottom">
      <Button size="small" variant="minimal" icon={<RefreshIcon/>} aria-label="Refresh" onClick={refresh}/>
    </Tooltip>
    <span className={`fb-summary ${Classes.TEXT_MUTED}`}>
      {listing.status === 'ok' && <>
        {query && <Tag minimal round>{shown.length.toLocaleString()} of {total.length.toLocaleString()}</Tag>} {summary}
      </>}
    </span>
  </div>
}


const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size', align: 'right' },
  { key: 'mtime', label: 'Modified' },
  { key: 'owner', label: 'Owner', className: 'fb-col-owner' },
]

function FileTable({ path, entries, sort, setSort, selected, setSelected, open, prefetch, copyPath, empty }) {
  const bodyRef = useRef(null)
  const windowed = entries.length > WINDOWING_THRESHOLD
  const [start, end] = useWindowedRange(entries.length, bodyRef, windowed)
  const now = useNow()
  const showWindows = hasPathMappings()

  // Keep the selected row on screen
  useEffect(() => {
    if (selected < 0 || !bodyRef.current) return
    const top = bodyRef.current.getBoundingClientRect().top + window.scrollY + selected * ROW_HEIGHT
    if (top < window.scrollY + STICKY_HEIGHT)
      window.scrollTo(0, top - STICKY_HEIGHT - ROW_HEIGHT)
    else if (top + ROW_HEIGHT > window.scrollY + window.innerHeight)
      window.scrollTo(0, top + 2 * ROW_HEIGHT - window.innerHeight)
  }, [selected])

  return <table className="fb-table" aria-label="Files">
    <colgroup>
      {COLUMNS.map(column => <col key={column.key} className={`fb-col-${column.key}`}/>)}
      <col className="fb-col-actions"/>
    </colgroup>
    <thead>
      <tr>
        {COLUMNS.map(column => {
          const isSorted = sort.key === column.key
          return <th key={column.key} className={`fb-col-${column.key}`} aria-sort={isSorted ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
            <button className="fb-sort" style={{ justifyContent: column.align === 'right' ? 'flex-end' : undefined }}
              onClick={() => setSort({ key: column.key, desc: isSorted ? !sort.desc : column.key === 'mtime' || column.key === 'size' })}>
              {column.label}{isSorted && <span className="fb-sort-arrow">{sort.desc ? '↓' : '↑'}</span>}
            </button>
          </th>
        })}
        <th className="fb-col-actions"><span className="fb-visually-hidden">Actions</span></th>
      </tr>
    </thead>
    <tbody ref={bodyRef}>
      {entries.length === 0 && <tr><td colSpan={COLUMNS.length + 1} className="fb-empty">{empty}</td></tr>}
      {start > 0 && <tr aria-hidden style={{ height: start * ROW_HEIGHT }}/>}
      {entries.slice(start, end).map((entry, i) => <FileRow
        key={entry.name}
        index={start + i}
        entry={entry}
        folder={path}
        now={now}
        isSelected={start + i === selected}
        setSelected={setSelected}
        open={open}
        prefetch={prefetch}
        copyPath={copyPath}
        showWindows={showWindows}
      />)}
      {end < entries.length && <tr aria-hidden style={{ height: (entries.length - end) * ROW_HEIGHT }}/>}
    </tbody>
  </table>
}


const FileRow = memo(function FileRow({ index, entry, folder, now, isSelected, setSelected, open, prefetch, copyPath, showWindows }) {
  const target = joinPath(folder, entry.name)
  const isDirectory = entry.type === 'directory'
  const href = urlFromPath(isDirectory ? `${target}/` : target)
  const Icon = ICONS[iconName(entry)] ?? DocumentIcon
  const details = [
    entry.link !== undefined && `→ ${entry.link}${entry.broken ? ' (broken link)' : ''}`,
    entry.mode,
  ].filter(Boolean).join('\n')
  // Keyboard users select rows with the arrows, see the hotkeys
  return <tr
    aria-selected={isSelected}
    className={`fb-row${isSelected ? ' fb-selected' : ''}${entry.broken ? ' fb-broken' : ''}${entry.name.startsWith('.') ? ' fb-hidden' : ''}`}
    onMouseDown={() => setSelected(index)}
    onDoubleClick={event => { if (!event.target.closest('a,button')) open(entry) }}
    onMouseEnter={() => prefetch(entry)}
    onMouseLeave={() => prefetch(null)}
  >
    <td className="fb-col-name">
      <a href={href} className="fb-name" onClick={event => open(entry, event)} title={details || undefined}>
        <Icon className={`fb-icon fb-icon-${isDirectory ? 'folder' : 'file'}`}/>
        <span className="fb-name-text">{entry.name}{isDirectory && '/'}</span>
        {entry.link !== undefined && <span className="fb-link">→ {entry.link}</span>}
      </a>
    </td>
    <td className="fb-col-size" title={entry.size !== undefined ? `${entry.size.toLocaleString()} bytes` : undefined}>
      {entry.size !== undefined ? formatSize(entry.size) : ''}
    </td>
    <td className="fb-col-mtime" title={formatAbsoluteTime(entry.mtime)}>
      {formatRelativeTime(entry.mtime, now)}
    </td>
    <td className="fb-col-owner" title={entry.mode}>{entry.owner}</td>
    <td className="fb-col-actions">
      <span className="fb-actions">
        <button className="fb-action" title="Copy the path" aria-label={`Copy the path of ${entry.name}`} onClick={() => copyPath(target)}><DuplicateIcon size={14}/></button>
        {showWindows && <button className="fb-action fb-action-text" title="Copy the Windows path" aria-label={`Copy the Windows path of ${entry.name}`} onClick={() => copyPath(target, true)}>Win</button>}
        {!isDirectory && <a className="fb-action" href={href} download title="Download" aria-label={`Download ${entry.name}`}><DownloadIcon size={14}/></a>}
      </span>
    </td>
  </tr>
})


// The time, in seconds, updated every minute
function useNow() {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now() / 1000), 60 * 1000)
    return () => clearInterval(interval)
  }, [])
  return now
}


// Renders only the rows on screen, for huge folders. The page scrolls, not the table.
function useWindowedRange(count, ref, enabled) {
  const [range, setRange] = useState([0, Math.min(count, 100)])
  useLayoutEffect(() => {
    if (!enabled) return
    let frame = null
    const update = () => {
      frame = null
      if (!ref.current) return
      const top = ref.current.getBoundingClientRect().top + window.scrollY
      const start = Math.max(0, Math.floor((window.scrollY - top) / ROW_HEIGHT) - 30)
      const end = Math.min(count, Math.ceil((window.scrollY + window.innerHeight - top) / ROW_HEIGHT) + 30)
      setRange(range => range[0] === start && range[1] === end ? range : [start, end])
    }
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [count, ref, enabled])
  return enabled ? range : [0, count]
}


function ErrorState({ error, path, user, navigate, onSignIn, retry, support_url }) {
  const parent = parentPath(path)
  const up = parent && <Button icon={<ArrowUpIcon/>} text="Parent folder" onClick={() => navigate(parent)}/>
  if (error.status === 401)
    return <NonIdealState className="fb-error" icon={<LockIcon size={48}/>} title="Sign in to see these files"
      description={error.message?.replace(/ Sign in[^.]*\.$/, '')} action={<Button intent={Intent.PRIMARY} icon={<LogInIcon/>} text="Sign in" onClick={onSignIn}/>}/>
  if (error.reason === 'forbidden')
    return <NonIdealState className="fb-error" icon={<LockIcon size={48}/>} title="You don't have access"
      description={<>
        <p>{error.message}</p>
        {user?.is_authenticated && <p className={Classes.TEXT_MUTED}>You are signed in as {user.user_name}.</p>}
        {support_url && <p><a href={support_url}>Ask for access</a></p>}
      </>}
      action={up}/>
  if (error.status === 404)
    return <NonIdealState className="fb-error" icon={<FolderCloseIcon size={48}/>} title="Not found" description={error.message} action={up}/>
  if (error.status === 403)
    return <NonIdealState className="fb-error" icon={<DisableIcon size={48}/>} title="Can't show this folder"
      description={error.message ?? "The server doesn't allow you to see this folder."} action={up}/>
  return <NonIdealState className="fb-error" icon={<WarningSignIcon size={48}/>} title="Could not load this folder"
    description={error.message ?? `${error}`} action={<Button icon={<RefreshIcon/>} text="Retry" onClick={retry}/>}/>
}


// nginx shows this page instead of a file it refused to send: we explain why
function FileAccess({ path, user, navigate, onSignIn, support_url }) {
  const [access, setAccess] = useState({ status: 'loading' })
  useEffect(() => {
    fetchAccess(path)
      .then(error => setAccess({ status: 'ok', error }))
      .catch(error => setAccess({ status: 'ok', error }))
  }, [path])
  const parent = parentPath(path)
  if (access.status === 'loading')
    return <div className="fb-loading"><Spinner size={SpinnerSize.SMALL}/></div>
  if (access.error)
    return <ErrorState error={access.error} path={path} user={user} navigate={navigate} onSignIn={onSignIn} retry={() => window.location.reload()} support_url={support_url}/>
  return <NonIdealState className="fb-error" icon={<DisableIcon size={48}/>} title={`Can't open ${baseName(path)}`}
    description="QA-Board allows you to see this file, but the server could not read it. Check its permissions."
    action={<ButtonGroup>
      <Button icon={<RefreshIcon/>} text="Retry" onClick={() => window.location.reload()}/>
      {parent && <Button icon={<ArrowUpIcon/>} text="Open the folder" onClick={() => navigate(parent, { focus: baseName(path) })}/>}
    </ButtonGroup>}
  />
}


const SIGN_IN_ERRORS = {
  'invalid-username': 'This username does not match any user account.',
  'invalid-password': 'The password is incorrect.',
}

function SignInDialog({ isOpen, onClose, onSignedIn }) {
  const [error, setError] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const usernameRef = useRef(null)
  const submit = async event => {
    event.preventDefault()
    const form = new FormData(event.target)
    setIsLoading(true)
    try {
      await signIn(form.get('username'), form.get('password'))
      setError(null)
      onSignedIn()
    } catch (e) {
      setError(SIGN_IN_ERRORS[e.message] ?? e.message ?? 'Could not sign in')
    } finally {
      setIsLoading(false)
    }
  }
  return <Dialog isOpen={isOpen} onClose={onClose} onOpened={() => usernameRef.current?.focus()} title="Sign in" icon={<LogInIcon/>} style={{ width: 360 }}>
    <form onSubmit={submit}>
      <DialogBody>
        <FormGroup label="Username" labelFor="fb-username">
          <InputGroup id="fb-username" name="username" inputRef={usernameRef} autoComplete="username"/>
        </FormGroup>
        <FormGroup label="Password" labelFor="fb-password" intent={error ? Intent.DANGER : Intent.NONE} helperText={error}>
          <InputGroup id="fb-password" name="password" type="password" autoComplete="current-password" intent={error ? Intent.DANGER : Intent.NONE}/>
        </FormGroup>
        <Button type="submit" intent={Intent.PRIMARY} fill loading={isLoading} text="Sign in"/>
      </DialogBody>
    </form>
  </Dialog>
}

