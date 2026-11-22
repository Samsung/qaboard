// What /api/v1/audit/actions answers (backend/audit_actions.py), a few of its actions
export const audit_registry = {
  categories: {
    sign_in: { label: 'Sign-in', icon: 'log-in' },
    tokens: { label: 'Tokens', icon: 'key' },
    users: { label: 'Users and groups', icon: 'people' },
    access: { label: 'Project access', icon: 'lock' },
    runs: { label: 'Runs and batches', icon: 'play' },
    milestones: { label: 'Milestones', icon: 'flag' },
  },
  actions: {
    'auth.login': { label: 'Signed in', category: 'sign_in', project: false },
    'auth.login_failed': { label: 'Failed to sign in', category: 'sign_in', project: false },
    'auth.signup': { label: 'Signed up', category: 'sign_in', project: false },
    'token.create': { label: 'Created a token', category: 'tokens', project: false },
    'token.revoke': { label: 'Revoked a token', category: 'tokens', project: false },
    'user.update': { label: 'Updated a user', category: 'users', project: false },
    'grant.create': { label: 'Gave a role', category: 'access', project: true },
    'batch.start': { label: 'Started a batch', category: 'runs', project: true },
    'batch.delete': { label: 'Deleted a batch', category: 'runs', project: true },
    'run.update': { label: 'Changed a run', category: 'runs', project: true },
    'milestone.create': { label: 'Saved a milestone', category: 'milestones', project: true },
  },
};
