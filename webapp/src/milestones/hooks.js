import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Intent } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { useUser } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { toaster } from "../toaster";
import {
  milestonesQuery, no_milestones, index_milestones, milestone_name,
  createMilestone, updateMilestone, deleteMilestone, setFavorite, importMilestones,
} from "./api";


// The project's milestones the user sees, indexed (see index_milestones). Empty while they load.
export const useMilestones = project => {
  const query = useQuery(milestonesQuery(project));
  return { ...(query.data ?? no_milestones), isPending: query.isPending && !!project, error: query.error };
};


// Saving, deleting, favorites. They toast what happened, and throw on errors.
export const useMilestoneActions = project => {
  const queryClient = useQueryClient();
  const queryKey = milestonesQuery(project).queryKey;
  // edit the cached list in place, the server's answer wins when it comes
  const update = change => queryClient.setQueryData(queryKey, index => index ? index_milestones(change(index.list)) : index);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['milestones'] });
  const fail = (what, error) => {
    toaster.show({ message: `Could not ${what}: ${errorMessage(error)}`, intent: Intent.DANGER, timeout: 6000 });
    throw error;
  };

  const save = async (fields, existing) => {
    try {
      const saved = existing ? await updateMilestone(existing.id, fields) : await createMilestone({ project, ...fields });
      update(list => existing ? list.map(m => m.id === saved.id ? saved : m) : [saved, ...list]);
      queryClient.setQueryData(['milestone', saved.id], saved);
      toaster.show({
        message: existing ? `Saved “${milestone_name(saved)}”` : `Saved the milestone “${milestone_name(saved)}”${saved.shared ? ', shared with the project' : ''}`,
        intent: Intent.SUCCESS, icon: 'star', timeout: 4000,
      });
      refresh();
      return saved;
    } catch (error) {
      return fail('save the milestone', error);
    }
  };

  const remove = async milestone => {
    try {
      await deleteMilestone(milestone.id);
      update(list => list.filter(m => m.id !== milestone.id));
      queryClient.removeQueries({ queryKey: ['milestone', milestone.id] });
      toaster.show({ message: `Deleted the milestone “${milestone_name(milestone)}”`, intent: Intent.SUCCESS, timeout: 4000 });
      refresh();
    } catch (error) {
      return fail('delete the milestone', error);
    }
  };

  const toggleFavorite = async milestone => {
    const is_favorite = !milestone.is_favorite;
    const set = value => {
      update(list => list.some(m => m.id === milestone.id) ? list.map(m => m.id === milestone.id ? { ...m, is_favorite: value } : m) : [...list, { ...milestone, is_favorite: value }]);
      queryClient.setQueryData(['milestone', milestone.id], m => m ? { ...m, is_favorite: value } : m);
    };
    set(is_favorite);
    try {
      await setFavorite(milestone.id, is_favorite);
    } catch (error) {
      set(!is_favorite);
      return fail(is_favorite ? 'add the milestone to your favorites' : 'remove the milestone from your favorites', error);
    }
  };

  return { save, remove, toggleFavorite };
};


// Until October 2026, "private" milestones were saved in browsers: {project: {key: milestone}}
export const useLegacyMilestones = () => usePrefsStore(state => state.milestones);
export const count_legacy = legacy => Object.values(legacy ?? {}).reduce((n, milestones) => n + Object.keys(milestones ?? {}).length, 0);

// Once users are logged in, we move them to their account, as personal milestones
export const useImportLegacyMilestones = () => {
  const user = useUser();
  const legacy = useLegacyMilestones();
  const queryClient = useQueryClient();
  // what we last tried to import: milestones the server can't take (e.g. projects the user can't access) stay in the
  // browser, and we don't send them again and again
  const attempted = useRef(null);
  const count = count_legacy(legacy);
  useEffect(() => {
    if (!user.is_logged || count === 0) return;
    const key = `${user.user_name}:${JSON.stringify(legacy)}`;
    if (attempted.current === key) return;
    attempted.current = key;
    importMilestones(legacy)
      .then(({ imported, done }) => {
        if (done.length > 0) usePrefsStore.getState().forgetLegacyMilestones(done);
        if (imported > 0) {
          toaster.show({
            message: `Moved ${imported} milestone${imported > 1 ? 's' : ''} from this browser to your account: they now follow you on every computer.`,
            intent: Intent.SUCCESS, icon: 'star', timeout: 8000,
          });
        }
        queryClient.invalidateQueries({ queryKey: ['milestones'] });
      })
      // we'll try again next time the app loads
      .catch(error => console.warn('Could not move the milestones saved in this browser', error));
  }, [user.is_logged, user.user_name, count, legacy, queryClient]);
};
