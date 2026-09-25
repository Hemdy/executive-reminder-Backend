export const seededPermissions = [
  ['read', 'tasks'], ['write', 'tasks'], ['read', 'reminders'], ['write', 'reminders'],
  ['read', 'requests'], ['write', 'requests'], ['read', 'meetings'], ['write', 'meetings'],
  ['read', 'notifications'], ['write', 'notifications'], ['users', 'admin'],
  ['view', 'roles'], ['create', 'roles'], ['edit', 'roles'], ['delete', 'roles'],
  ['view', 'users'], ['create', 'users'], ['edit', 'users'], ['delete', 'users'],
  ['view', 'dashboard'], ['view', 'settings'], ['edit', 'settings'],
] as const;
