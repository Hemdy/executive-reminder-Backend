SELECT 'ApprovalRequest' AS table_name, count(*)::bigint AS row_count FROM public."ApprovalRequest"
UNION ALL SELECT 'Meeting', count(*)::bigint FROM public."Meeting"
UNION ALL SELECT 'MeetingAttachment', count(*)::bigint FROM public."MeetingAttachment"
UNION ALL SELECT 'MeetingComment', count(*)::bigint FROM public."MeetingComment"
UNION ALL SELECT 'MeetingParticipant', count(*)::bigint FROM public."MeetingParticipant"
UNION ALL SELECT 'Notification', count(*)::bigint FROM public."Notification"
UNION ALL SELECT 'NotificationEvent', count(*)::bigint FROM public."NotificationEvent"
UNION ALL SELECT 'NotificationPreference', count(*)::bigint FROM public."NotificationPreference"
UNION ALL SELECT 'Permission', count(*)::bigint FROM public."Permission"
UNION ALL SELECT 'PushDeliveryLog', count(*)::bigint FROM public."PushDeliveryLog"
UNION ALL SELECT 'PushSubscription', count(*)::bigint FROM public."PushSubscription"
UNION ALL SELECT 'Reminder', count(*)::bigint FROM public."Reminder"
UNION ALL SELECT 'ReminderAttachment', count(*)::bigint FROM public."ReminderAttachment"
UNION ALL SELECT 'ReminderComment', count(*)::bigint FROM public."ReminderComment"
UNION ALL SELECT 'ReminderParticipant', count(*)::bigint FROM public."ReminderParticipant"
UNION ALL SELECT 'Request', count(*)::bigint FROM public."Request"
UNION ALL SELECT 'RequestAttachment', count(*)::bigint FROM public."RequestAttachment"
UNION ALL SELECT 'RequestComment', count(*)::bigint FROM public."RequestComment"
UNION ALL SELECT 'Role', count(*)::bigint FROM public."Role"
UNION ALL SELECT 'RolePermission', count(*)::bigint FROM public."RolePermission"
UNION ALL SELECT 'Task', count(*)::bigint FROM public."Task"
UNION ALL SELECT 'TaskAttachment', count(*)::bigint FROM public."TaskAttachment"
UNION ALL SELECT 'TaskComment', count(*)::bigint FROM public."TaskComment"
UNION ALL SELECT 'TaskParticipant', count(*)::bigint FROM public."TaskParticipant"
UNION ALL SELECT 'User', count(*)::bigint FROM public."User"
UNION ALL SELECT '_prisma_migrations', count(*)::bigint FROM public."_prisma_migrations"
UNION ALL SELECT 'CHECK:email_normalization_collisions', count(*)::bigint
  FROM (
    SELECT lower(btrim("email"))
    FROM public."User"
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) AS email_collisions
UNION ALL SELECT 'CHECK:users_without_role', count(*)::bigint
  FROM public."User" AS u
  LEFT JOIN public."Role" AS assigned_role ON assigned_role."id" = u."roleId"
  LEFT JOIN public."Role" AS named_role ON named_role."name" = u."role"
  WHERE (u."roleId" IS NULL AND named_role."id" IS NULL)
     OR (u."roleId" IS NOT NULL AND assigned_role."id" IS NULL)
UNION ALL SELECT 'CHECK:user_role_name_mismatches', count(*)::bigint
  FROM public."User" AS u
  JOIN public."Role" AS assigned_role ON assigned_role."id" = u."roleId"
  WHERE assigned_role."name" <> u."role"
ORDER BY table_name;
