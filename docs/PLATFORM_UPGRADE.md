# Fawater — Complete platform upgrade

This is an additive implementation track. The existing invoice workflow, records, attachments, and browser IndexedDB store are preserved.

## Included in migration 002
- Auth user profiles and organization memberships with owner/admin/accountant/sales/employee/viewer roles.
- Organization invitations (hashed tokens only; sending/acceptance endpoints are a separate application task).
- Customer and supplier directories.
- Expenses, expense categories, invoice payment ledger, and per-organization tax settings.
- Plan catalogue, organization subscription lifecycle, provider event idempotency records.
- Notifications and preferences, backup run metadata, security event log, feature flags.
- Tenant-aware RLS for existing invoice, item, attachment, custom-field, export, and audit tables.
- Private storage policies compatible with the current object naming convention: organization UUID / invoice UUID / filename.
- Missing foreign-key indexes identified in the initial audit and a hardened trigger search_path.

## Mandatory rollout gates
1. This migration must be reviewed and tested in a disposable Supabase branch before production.
2. The current Express API uses a service-role client. Service-role calls bypass RLS, so every API route still needs verified Supabase Auth JWT middleware plus organization membership/role authorization. Do not expose the service-role key to the browser.
3. The existing React app currently has no Auth provider/login flow. Add login, logout, recovery, MFA enrollment, invitation acceptance, and session refresh while retaining local-first operation and safe sync retries.
4. Existing organizations created by server-side jobs do not gain an owner retroactively. Map each legacy organization to a verified owner before switching its users to authenticated access.
5. Payment gateway, transactional email/SMS provider, and backup destination require owner-approved providers and secrets. No payment collection, email sending, or actual backup is activated by schema alone.
6. A backup metadata table is not a backup. Configure external encrypted backups and perform a restore drill.
7. Run cross-tenant tests with two users, API auth tests, storage isolation tests, offline queue replay tests, lint/build, and browser tests before merge/deploy.

## Remaining product tracks
- Full Arabic-first auth and team-management UI; audit log viewer.
- Customers, suppliers, expenses, payment allocation, tax reports, receivables/payables, cash-flow and profit/loss dashboards.
- Subscription checkout, webhook verification, quotas/entitlements, grace periods and cancellation.
- AI extraction confidence, duplicate detection, review queues, retry/dead-letter handling, usage metering.
- PDF/Excel reports, scheduled exports, email notifications and in-app notification center.
- Backups, restore runbooks, monitoring, structured logs, alerts, retention policies and incident response.
- Automated unit/integration/E2E testing, accessibility, mobile QA, dependency scanning and CI/CD deployment gates.
