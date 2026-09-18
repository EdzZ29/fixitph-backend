-- ===========================================================================
-- Row level security for message attachments
--
-- The table has existed since the first migration and nothing has ever
-- written to it, so it was never reachable and never needed a policy. Image
-- attachments change that, and a photo sent inside a private thread is as
-- private as the message carrying it — a customer photographing a burst pipe
-- is photographing the inside of their home.
--
-- The policy delegates to the message, which is where the answer already
-- lives: messages is itself under row level security, restricted to its
-- sender and recipient. Restating that rule here would mean two definitions
-- of who may read a thread, and they would eventually disagree.
--
-- Safe to enforce, because this table is only ever touched with a session
-- established: the thread read and the attachment upload both run inside
-- withUser. A pre-session read would return nothing rather than fail, which
-- is the trap this codebase has met before.
-- ===========================================================================

ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY message_attachments_select ON "message_attachments"
  FOR SELECT USING (
    app.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = "message_id"
        AND (
          m.sender_id = app.current_user_id()
          OR m.recipient_id = app.current_user_id()
        )
    )
  );

-- Only the sender of the message may attach to it.
CREATE POLICY message_attachments_insert ON "message_attachments"
  FOR INSERT WITH CHECK (
    app.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = "message_id" AND m.sender_id = app.current_user_id()
    )
  );

-- No UPDATE or DELETE policy: an attachment is immutable once sent, and the
-- row goes when its message does, by cascade.
