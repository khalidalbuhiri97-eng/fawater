# Fawater authentication and production rollout

## Implemented in this branch
- Arabic-first email/password sign-in and account creation through Supabase Auth.
- Password reset email and recovery callback for setting a new password.
- Persistent Supabase browser sessions and automatic access-token refresh.
- Authorization header injection for same-origin API calls.
- Server-side JWT verification before API access; the service-role key remains server-only.
- Active organization membership checks and role gates for invoice, attachment, export, custom-field, organization, template, and background-job endpoints.
- Bootstrap responses are filtered to organizations the signed-in user belongs to.
- Local IndexedDB data and sync queues are isolated by authenticated user ID.
- Additive tenant schema: profiles, organization memberships, invitations, customer/supplier directories, expenses, payment ledger, tax settings, subscriptions, notifications, backup metadata, security events, feature flags, and tenant-aware RLS/storage policies.

## Required deployment configuration
Browser build variables:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` (preferred) or `VITE_SUPABASE_ANON_KEY`

Server variables:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY` for JWT verification
- `SUPABASE_SERVICE_ROLE_KEY` (server secret only; never expose as VITE_ variable)
- Existing `GEMINI_API_KEY` and `APP_URL`

## Supabase Auth dashboard
1. Enable Email provider.
2. Set the production Site URL and allowed redirect URLs.
3. Configure custom SMTP before production password reset/signup confirmation.
4. Decide whether email confirmation is required.
5. Configure rate limits and abuse protection; enable MFA policy for privileged users.

## Database rollout gate
The migration is intentionally included but is not applied to production by this code change. Before applying it:
1. Validate it on a disposable Supabase branch/project.
2. Review existing RLS policies and ensure no conflicting policy names.
3. Test with at least two users in two separate organizations; cross-tenant reads/writes must fail.
4. Test owner/admin/accountant/sales/employee/viewer permissions and storage path isolation.
5. Map any pre-existing organizations to verified owners. The migration does not automatically claim legacy organizations.
6. Run migration, then Supabase security/performance advisors and integration tests.

## First-account / legacy data
Existing offline records are retained in the original unscoped local database. The first authenticated session uses a user-scoped database, so legacy local records must be deliberately imported into the correct account/organization after owner verification. Do not blindly assign another person's local data to a new account.

## Not activated by schema alone
Invitation email delivery, payment gateway checkout/webhooks, external encrypted backups and restore drills, scheduled notifications, and subscription billing require provider configuration and separate verified workflows.
