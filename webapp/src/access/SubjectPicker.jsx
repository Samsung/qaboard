// Picks a user or a group from the directory (/api/v1/directory), e.g. to add members.
//   <SubjectPicker id="new-member" value={subject} onChange={setSubject}/>
// Subjects are {type: "user"|"group", id, name, user_name?, full_name?}. `types={['user']}` only offers users.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MenuItem, Spinner } from "@blueprintjs/core";
import { Suggest } from "@blueprintjs/select";

import { errorMessage } from "../api/http";
import { directoryQuery } from "./api";


const subject_key = subject => `${subject.type}:${subject.id}`;
const subjectLabel = subject => subject.type === 'group'
  ? subject.name
  : subject.full_name ? `${subject.full_name} (${subject.user_name})` : subject.user_name;

// The server searches: we show what it answers, users first
export const directorySubjects = (data, types = ['user', 'group']) => [
  ...(types.includes('user') ? (data?.users ?? []).map(user => ({ type: 'user', id: user.id, user_name: user.user_name, full_name: user.full_name, name: user.user_name, kind: user.kind })) : []),
  ...(types.includes('group') ? (data?.groups ?? []).map(group => ({ type: 'group', id: group.id, name: group.name })) : []),
];

const renderSubject = (subject, { handleClick, handleFocus, modifiers, ref }) => {
  if (!modifiers.matchesPredicate) return null;
  return <MenuItem
    key={subject_key(subject)}
    ref={ref}
    roleStructure="listoption"
    active={modifiers.active}
    disabled={modifiers.disabled}
    icon={subject.type === 'group' ? 'people' : 'person'}
    text={subject.type === 'group' ? subject.name : (subject.full_name || subject.user_name)}
    label={subject.type === 'group' ? 'Group' : subject.full_name ? subject.user_name : undefined}
    onClick={handleClick}
    onFocus={handleFocus}
  />;
};


export const SubjectPicker = ({ id, value = null, onChange, types = ['user', 'group'], placeholder, disabled = false, exclude = [] }) => {
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [open, setOpen] = useState(false);
  // the directory is searched a moment after users stop typing
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, isFetching, error } = useQuery({ ...directoryQuery(searched), enabled: open || !!searched });
  const excluded = new Set(exclude.map(subject_key));
  const items = directorySubjects(data, types).filter(subject => !excluded.has(subject_key(subject)));
  const what = types.includes('group') ? 'users or groups' : 'users';

  return <Suggest
    items={items}
    itemRenderer={renderSubject}
    itemsEqual={(a, b) => subject_key(a) === subject_key(b)}
    selectedItem={value}
    onItemSelect={subject => {
      onChange(subject);
      setQuery('');
    }}
    inputValueRenderer={subjectLabel}
    query={query}
    onQueryChange={setQuery}
    disabled={disabled}
    fill
    resetOnClose
    noResults={<MenuItem
      disabled
      roleStructure="listoption"
      text={error ? errorMessage(error) : isFetching ? 'Searching…' : searched ? `No ${what} match “${searched}”.` : `Type to search ${what}.`}
    />}
    popoverProps={{ minimal: true, matchTargetWidth: true, onOpening: () => setOpen(true) }}
    inputProps={{
      id,
      placeholder: placeholder ?? (types.includes('group') ? 'Search a user or a group…' : 'Search a user…'),
      leftIcon: value?.type === 'group' ? 'people' : 'person',
      rightElement: isFetching ? <Spinner size={16} style={{ margin: 7 }}/> : undefined,
      autoComplete: 'off',
    }}
  />;
};

export default SubjectPicker;
