-- Apply this in Lovable's Supabase SQL editor (or via the CLI).
-- It enables the recording flow to work without the service-role key on the
-- backend, by letting users access their own rows under RLS.
--
-- Tables expected: public.calls, public.call_recordings
-- Storage bucket expected: 'recordings'
--
-- Safe to run multiple times: each policy is dropped before being recreated.

------------------------------------------------------------
-- calls: a participant can see and update their own call rows
------------------------------------------------------------
alter table public.calls enable row level security;

drop policy if exists "calls_select_participant" on public.calls;
create policy "calls_select_participant"
on public.calls
for select
to authenticated
using (auth.uid() = caller_id or auth.uid() = receiver_id);

drop policy if exists "calls_update_participant" on public.calls;
create policy "calls_update_participant"
on public.calls
for update
to authenticated
using  (auth.uid() = caller_id or auth.uid() = receiver_id)
with check (auth.uid() = caller_id or auth.uid() = receiver_id);

-- (Insert is presumably already covered by your existing frontend insert policy.
--  If not, uncomment:)
-- drop policy if exists "calls_insert_participant" on public.calls;
-- create policy "calls_insert_participant"
-- on public.calls for insert to authenticated
-- with check (auth.uid() = caller_id);

------------------------------------------------------------
-- call_recordings: only the subscriber can read their recording rows.
-- Inserts/updates are done by the Edge Function with service-role,
-- so no insert/update policies are needed for clients.
------------------------------------------------------------
alter table public.call_recordings enable row level security;

drop policy if exists "call_recordings_select_subscriber" on public.call_recordings;
create policy "call_recordings_select_subscriber"
on public.call_recordings
for select
to authenticated
using (auth.uid() = subscriber_user_id);

------------------------------------------------------------
-- Storage: recordings bucket
-- Files are uploaded as `<subscriber_user_id>/<call_id>.<ext>`.
-- Allow the owning subscriber to read their own object (so the Railway
-- backend can mint signed URLs under the user's JWT).
------------------------------------------------------------
drop policy if exists "recordings_select_owner" on storage.objects;
create policy "recordings_select_owner"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'recordings'
  and auth.uid()::text = (storage.foldername(name))[1]
);

-- Make sure the bucket exists and is private. (No-op if it already exists.)
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;
