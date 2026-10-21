// Settings → Activity: the user's sign-ins, tokens and CLI sign-ins, from the audit log
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Classes, NonIdealState } from "@blueprintjs/core";

import { QueryError, Loading } from "./states";
import { userAuditQuery } from "./api";
import { AuditEvents } from "./AuditEvents";


export const ActivityTab = ({ user }) => {
  const { data, isPending, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery(userAuditQuery);
  const events = data?.pages.flatMap(page => page.events) ?? [];
  return <section aria-label="Activity">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0 }}>
      Sign-ins, tokens and CLI sign-ins of your account. If something looks wrong, revoke your tokens and tell an admin.
    </p>
    {isPending && <Loading label="Loading your activity"/>}
    {error && <QueryError error={error} refetch={refetch} what="your activity"/>}
    {!isPending && !error && (events.length === 0
      ? <NonIdealState icon="history" title="No activity yet" description="Your sign-ins and tokens will show up here."/>
      : <>
        <AuditEvents events={events} self_id={user.user_id}/>
        {hasNextPage && <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <Button variant="minimal" icon="chevron-down" text="Load more" loading={isFetchingNextPage} onClick={() => fetchNextPage()}/>
        </div>}
      </>)}
  </section>;
};

export default ActivityTab;
