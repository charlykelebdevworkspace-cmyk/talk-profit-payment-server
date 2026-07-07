-- Apply this in Lovable's Supabase SQL editor (or via the CLI).
--
-- Root cause of "app keeps asking the user to subscribe after they paid":
-- the Stripe subscription webhook on the Railway backend writes the
-- public.subscriptions row using the *anon* key (this project has no
-- service-role key on the backend). That write is an anonymous request with no
-- auth.uid(), so RLS on public.subscriptions silently rejects it and the row is
-- never persisted. The app then reads its own subscription row (under RLS),
-- finds nothing, and keeps prompting to subscribe.
--
-- Fix: expose a SECURITY DEFINER function the anon backend can call to upsert
-- the subscription row, bypassing RLS the same way the recording Edge Function
-- does. Also (re)create the SELECT policy so an authenticated user can read
-- their own subscription row.
--
-- Safe to run multiple times.

------------------------------------------------------------
-- subscriptions: RLS + owner-read policy
------------------------------------------------------------
alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_owner" on public.subscriptions;
create policy "subscriptions_select_owner"
on public.subscriptions
for select
to authenticated
using (auth.uid() = user_id);

------------------------------------------------------------
-- SECURITY DEFINER upsert used by the Stripe subscription webhook.
-- Runs as the function owner, so it bypasses RLS. Keyed on
-- stripe_subscription_id (must be unique for ON CONFLICT to work).
------------------------------------------------------------
create or replace function public.upsert_recording_subscription(
  p_user_id uuid,
  p_product text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscriptions (
    user_id,
    product,
    stripe_customer_id,
    stripe_subscription_id,
    status,
    current_period_end,
    cancel_at_period_end
  )
  values (
    p_user_id,
    coalesce(p_product, 'call_recording'),
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_status,
    p_current_period_end,
    coalesce(p_cancel_at_period_end, false)
  )
  on conflict (stripe_subscription_id) do update set
    user_id             = excluded.user_id,
    product             = excluded.product,
    stripe_customer_id  = excluded.stripe_customer_id,
    status              = excluded.status,
    current_period_end  = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end;
end;
$$;

-- The Railway backend calls this with the anon key (no user JWT), so anon must
-- be able to execute it. authenticated/service_role included for completeness.
grant execute on function public.upsert_recording_subscription(
  uuid, text, text, text, text, timestamptz, boolean
) to anon, authenticated, service_role;
