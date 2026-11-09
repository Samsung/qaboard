// Whose runs a page shows (Storage usage, Runs activity): yours, everyone's, or one person's.
//   <WhoseRuns scope={filters.scope} user={filters.user} onChange={({ scope, user }) => ...}/>
// People are picked from the directory, or typed: runs say who ran them with their name on the machine that ran
// them, which may not be a QA-Board account.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MenuItem, SegmentedControl, Spinner } from "@blueprintjs/core";
import { Suggest } from "@blueprintjs/select";

import { directoryQuery } from "../access/api";


const renderPerson = (person, { handleClick, handleFocus, modifiers, ref }) => {
  if (!modifiers.matchesPredicate) return null;
  return <MenuItem
    key={person.user_name}
    ref={ref}
    roleStructure="listoption"
    active={modifiers.active}
    icon="person"
    text={person.full_name || person.user_name}
    label={person.full_name ? person.user_name : undefined}
    onClick={handleClick}
    onFocus={handleFocus}
  />;
};

export const PersonPicker = ({ value, onChange, autoFocus = false, placeholder = "Whose runs? Search or type a user name…" }) => {
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, isFetching } = useQuery({ ...directoryQuery(searched), enabled: !!searched });
  const typed = query.trim();
  const people = (data?.users ?? []).map(u => ({ user_name: u.user_name, full_name: u.full_name }));
  return <Suggest
    items={people}
    itemRenderer={renderPerson}
    itemsEqual={(a, b) => a.user_name === b.user_name}
    selectedItem={value ? { user_name: value } : null}
    onItemSelect={person => {
      setQuery('');
      if (person.user_name) onChange(person.user_name);
    }}
    inputValueRenderer={person => person.user_name}
    query={query}
    onQueryChange={setQuery}
    // the runs of someone who isn't in the directory: what users typed
    createNewItemFromQuery={q => ({ user_name: q.trim() })}
    createNewItemRenderer={(q, active, handleClick) => q.trim() && !people.some(p => p.user_name === q.trim())
      ? <MenuItem key="typed" icon="search" roleStructure="listoption" active={active} onClick={handleClick} text={<>Runs of <strong>{q.trim()}</strong></>}/>
      : undefined}
    createNewItemPosition="last"
    resetOnClose
    noResults={<MenuItem disabled roleStructure="listoption" text={isFetching ? 'Searching…' : typed ? 'No account matches: press Enter to use this name.' : 'Type a user name.'}/>}
    popoverProps={{ minimal: true, matchTargetWidth: true }}
    inputProps={{
      'aria-label': 'Whose runs',
      placeholder,
      leftIcon: 'person',
      autoFocus,
      rightElement: isFetching ? <Spinner size={16} style={{ margin: 7 }}/> : undefined,
      autoComplete: 'off',
      style: { width: 260 },
    }}
  />;
};


// `everyone`: whether users may see other people's runs
export const WhoseRuns = ({ scope, user, onChange, everyone = true }) => {
  const current = scope || 'me';
  // "Someone…" is picked: we wait for a name before changing the page
  const [picking, setPicking] = useState(false);
  const shown = picking ? 'user' : current;
  if (!everyone) return null;
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
    <SegmentedControl
      aria-label="Whose runs"
      options={[{ label: 'Your runs', value: 'me' }, { label: "Everyone's", value: 'all' }, { label: 'Someone…', value: 'user' }]}
      value={shown}
      onValueChange={value => {
        if (value === 'user') return setPicking(true);
        setPicking(false);
        onChange({ scope: value, user: '' });
      }}
    />
    {shown === 'user' && <PersonPicker value={current === 'user' ? user : null} autoFocus={picking} onChange={name => {
      setPicking(false);
      onChange({ scope: 'user', user: name });
    }}/>}
  </div>;
};

export default WhoseRuns;
