-- ============================================================
-- supabase-setup.sql
-- Run this in Supabase → SQL Editor (run once)
-- ============================================================

-- ── 1. App data (same as before) ─────────────────────────────
create table if not exists app_data (
  workspace_id  text        primary key,
  payload       jsonb       not null default '{}'::jsonb,
  version       integer     not null default 1,
  updated_at    timestamptz not null default now()
);

-- ── 2. Users / permissions table ─────────────────────────────
-- "pending"  → registered, waiting for admin approval
-- "viewer"   → can see everything, cannot edit
-- "editor"   → full read+write access
-- "admin"    → same as editor + can manage users
create table if not exists app_users (
  id           uuid        primary key default gen_random_uuid(),
  email        text        unique not null,
  role         text        not null default 'pending'
                           check (role in ('pending','viewer','editor','admin','unit_viewer')),
  unit_id      integer     default null,  -- non-null only for unit_viewer role
  display_name text,
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  text
);
-- role=unit_viewer + unit_id=X → can only see bills/payment-demands for unit X

-- ── 3. RLS — app_data ────────────────────────────────────────
alter table app_data enable row level security;

-- Only approved users (viewer/editor/admin) can read
create policy "approved read app_data"
  on app_data for select
  using (
    exists (
      select 1 from app_users
      where email = current_setting('request.jwt.claims', true)::json->>'email'
        and role in ('viewer','editor','admin')
    )
  );

-- Only editors/admins can write
create policy "editor write app_data"
  on app_data for all
  using (
    exists (
      select 1 from app_users
      where email = current_setting('request.jwt.claims', true)::json->>'email'
        and role in ('editor','admin')
    )
  );

-- ── 4. RLS — app_users ───────────────────────────────────────
alter table app_users enable row level security;

-- Anyone can insert their own pending record (self-registration)
create policy "self register"
  on app_users for insert
  with check (true);

-- Users can read their own row (to know their role)
create policy "read own row"
  on app_users for select
  using (
    email = current_setting('request.jwt.claims', true)::json->>'email'
    or exists (
      select 1 from app_users u2
      where u2.email = current_setting('request.jwt.claims', true)::json->>'email'
        and u2.role = 'admin'
    )
  );

-- Only admins can update roles
create policy "admin update roles"
  on app_users for update
  using (
    exists (
      select 1 from app_users u2
      where u2.email = current_setting('request.jwt.claims', true)::json->>'email'
        and u2.role = 'admin'
    )
  );

-- ── 5. Seed the first admin ───────────────────────────────────
-- IMPORTANT: Replace with your own email before running!
-- After running, sign up with this email in the app — you'll get admin access.
insert into app_users (email, role, display_name, approved_at)
values ('YOUR_ADMIN_EMAIL@example.com', 'admin', 'מנהל', now())
on conflict (email) do update set role = 'admin';

-- ── 6. Helper: get current user role (used by API) ───────────
create or replace function get_user_role(user_email text)
returns text language sql security definer as $$
  select role from app_users where email = user_email;
$$;

-- ── 7. Auto-create app_users row on Supabase auth signup ─────────────────────
-- This ensures every user who signs up via magic link gets a "pending" row
create or replace function handle_new_auth_user()
returns trigger language plpgsql security definer as $$
begin
  insert into app_users (email, role, display_name)
  values (new.email, 'pending', split_part(new.email, '@', 1))
  on conflict (email) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();
