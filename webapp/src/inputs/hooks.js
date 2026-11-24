import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Intent } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { track } from "../analytics";
import {
  collectionsQuery, createCollection, saveVersion, updateCollection, setFavorite, setPin, pretty_name,
  is_pinned_for, pin_key, pin_label, everyone,
} from "./api";


// The collections users see from a project: its own and its ancestors'. Empty while they load.
export const useCollections = (project, { archived = false } = {}) => {
  const query = useQuery(collectionsQuery(project, { archived }));
  return {
    list: query.data?.collections ?? [],
    my_groups: query.data?.my_groups ?? [],
    // whether the user can create collections in the project: personal ones once signed in. Undefined while loading
    can_create: query.data?.can_create,
    // and share them with the project (collections.write: developers and owners)
    can_share: query.data?.can_share,
    can_pin_everyone: query.data?.can_pin_everyone,
    isPending: query.isPending && !!project,
    error: query.error,
    refetch: query.refetch,
  };
};


// Saving, archiving, favorites and pins. They toast errors, and throw them, except 409s that callers handle.
export const useCollectionActions = project => {
  const queryClient = useQueryClient();
  const refresh = id => {
    queryClient.invalidateQueries({ queryKey: ['collections'] });
    if (id !== undefined) {
      queryClient.invalidateQueries({ queryKey: ['collection', Number(id)] });
      queryClient.invalidateQueries({ queryKey: ['collection-inputs', Number(id)] });
    }
  };
  // edits the cached collection everywhere: lists and pages
  const patch = (id, change) => {
    queryClient.setQueriesData({ queryKey: ['collections'] }, data => data?.collections
      ? { ...data, collections: data.collections.map(c => c.id === id ? { ...c, ...change(c) } : c) }
      : data);
    queryClient.setQueriesData({ queryKey: ['collection', Number(id)] }, data => data ? { ...data, ...change(data) } : data);
  };
  const fail = (what, error) => {
    if (error?.response?.status !== 409)
      toaster.show({ message: `Could not ${what}: ${errorMessage(error)}`, intent: Intent.DANGER, timeout: 6000 });
    throw error;
  };

  const create = async fields => {
    try {
      const saved = await createCollection({ project, ...fields });
      track('collection_create', { inputs: fields.inputs.length }, { project_id: project });
      refresh();
      return saved;
    } catch (error) {
      return fail('save the collection', error);
    }
  };

  // a new version with these inputs, on top of `base_version`
  const save = async (collection, { inputs, base_version, notes }) => {
    try {
      const saved = await saveVersion(collection.id, { inputs, base_version, notes });
      track('collection_version', { inputs: inputs.length }, { project_id: project });
      refresh(collection.id);
      return saved;
    } catch (error) {
      return fail(`save a new version of ${pretty_name(collection.name)}`, error);
    }
  };

  const toggleFavorite = async collection => {
    const favorite = !collection.favorite;
    patch(collection.id, () => ({ favorite }));
    try {
      await setFavorite(collection.id, favorite, project);
    } catch (error) {
      patch(collection.id, () => ({ favorite: !favorite }));
      return fail(favorite ? 'add the collection to your favorites' : 'remove the collection from your favorites', error);
    }
  };

  // group: {id, name}, or null for everyone on the project
  const togglePin = async (collection, group) => {
    const pinned = !is_pinned_for(collection, group);
    const set = value => patch(collection.id, c => ({
      pinned_for: value ? [...(c.pinned_for ?? []), group ?? everyone] : (c.pinned_for ?? []).filter(g => pin_key(g) !== pin_key(group)),
    }));
    set(pinned);
    try {
      await setPin(collection.id, pin_key(group) === 'everyone' ? null : group.id ?? group, pinned);
      toaster.show({ message: pinned ? `Pinned ${pretty_name(collection.name)} for ${pin_label(group)}` : `Unpinned ${pretty_name(collection.name)} for ${pin_label(group)}`, intent: Intent.SUCCESS, icon: 'pin', timeout: 3000 });
      refresh(collection.id);
    } catch (error) {
      set(!pinned);
      return fail(pinned ? 'pin the collection' : 'unpin the collection', error);
    }
  };

  const setArchived = async (collection, archived) => {
    try {
      await updateCollection(collection.id, { archived });
      patch(collection.id, () => ({ archived }));
      toaster.show({
        message: archived ? `Archived ${pretty_name(collection.name)}: hidden from lists, it still works in code and batch files` : `Unarchived ${pretty_name(collection.name)}`,
        intent: Intent.SUCCESS, icon: archived ? 'archive' : 'unarchive', timeout: 5000,
      });
      refresh(collection.id);
    } catch (error) {
      return fail(archived ? 'archive the collection' : 'unarchive the collection', error);
    }
  };

  const describe = async (collection, fields) => {
    try {
      const saved = await updateCollection(collection.id, fields);
      patch(collection.id, () => fields);
      refresh(collection.id);
      return saved;
    } catch (error) {
      return fail('save the collection', error);
    }
  };

  // shared: with the project, or personal again (its creator only)
  const setShared = async (collection, shared) => {
    try {
      await updateCollection(collection.id, { shared });
      patch(collection.id, () => ({ shared }));
      toaster.show({
        message: shared ? `Shared ${pretty_name(collection.name)} with the project` : `${pretty_name(collection.name)} is personal again: only you see it`,
        intent: Intent.SUCCESS, icon: shared ? 'people' : 'person', timeout: 5000,
      });
      refresh(collection.id);
    } catch (error) {
      return fail(shared ? 'share the collection' : 'make the collection personal', error);
    }
  };

  return { create, save, toggleFavorite, togglePin, setArchived, setShared, describe, refresh };
};
