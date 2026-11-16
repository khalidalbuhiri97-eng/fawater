-- Additive Fawater platform foundation. Existing business records are not rewritten or deleted.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE TABLE IF NOT EXISTS public.user_profiles (
 id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 full_name text NOT NULL DEFAULT '', phone text, avatar_url text,
 locale text NOT NULL DEFAULT 'ar', timezone text NOT NULL DEFAULT 'Asia/Aden',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.organization_members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK (role IN ('owner','admin','accountant','sales','employee','viewer')),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
 invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 joined_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON public.organization_members(user_id,status);
CREATE INDEX IF NOT EXISTS idx_org_members_org_role ON public.organization_members(organization_id,role,status);

CREATE TABLE IF NOT EXISTS public.organization_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 email text NOT NULL, role text NOT NULL CHECK (role IN ('admin','accountant','sales','employee','viewer')),
 token_hash text NOT NULL UNIQUE, invited_by uuid NOT NULL REFERENCES auth.users(id),
 expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON public.organization_invitations(lower(email));

CREATE TABLE IF NOT EXISTS public.customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 name text NOT NULL, phone text, email text, address text, tax_id text, notes text NOT NULL DEFAULT '',
 opening_balance numeric(14,2) NOT NULL DEFAULT 0, currency text, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_org_name ON public.customers(organization_id,lower(name));

CREATE TABLE IF NOT EXISTS public.suppliers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 name text NOT NULL, phone text, email text, address text, tax_id text, notes text NOT NULL DEFAULT '',
 opening_balance numeric(14,2) NOT NULL DEFAULT 0, currency text, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_org_name ON public.suppliers(organization_id,lower(name));

CREATE TABLE IF NOT EXISTS public.expense_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 name text NOT NULL, color text, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,name)
);
CREATE TABLE IF NOT EXISTS public.expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 category_id uuid REFERENCES public.expense_categories(id) ON DELETE SET NULL,
 description text NOT NULL, amount numeric(14,2) NOT NULL CHECK(amount>=0),
 currency text NOT NULL DEFAULT '', expense_date date NOT NULL DEFAULT CURRENT_DATE,
 payment_method text, reference_number text, supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
 notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'approved'
 CHECK(status IN ('draft','pending','approved','rejected')),
 created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_org_date ON public.expenses(organization_id,expense_date DESC);

CREATE TABLE IF NOT EXISTS public.invoice_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
 amount numeric(14,2) NOT NULL CHECK(amount>0), currency text NOT NULL DEFAULT '',
 payment_date date NOT NULL DEFAULT CURRENT_DATE, payment_method text, reference_number text,
 notes text NOT NULL DEFAULT '', created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice_date ON public.invoice_payments(invoice_id,payment_date DESC);

CREATE TABLE IF NOT EXISTS public.organization_tax_settings (
 organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
 tax_number text, default_tax_rate numeric(7,4) NOT NULL DEFAULT 0,
 default_currency text NOT NULL DEFAULT '', country_code text,
 tax_inclusive boolean NOT NULL DEFAULT false, settings jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscription_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_key text NOT NULL UNIQUE,
 name text NOT NULL, description text NOT NULL DEFAULT '',
 monthly_price numeric(14,2), yearly_price numeric(14,2), currency text NOT NULL DEFAULT 'USD',
 max_users integer, max_organizations integer, max_invoices_per_month integer,
 features jsonb NOT NULL DEFAULT '{}'::jsonb, is_active boolean NOT NULL DEFAULT true,
 sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.organization_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
 plan_id uuid REFERENCES public.subscription_plans(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'trialing'
 CHECK(status IN ('trialing','active','past_due','paused','canceled','expired')),
 billing_provider text, provider_customer_id text, provider_subscription_id text,
 current_period_start timestamptz, current_period_end timestamptz, trial_ends_at timestamptz,
 cancel_at_period_end boolean NOT NULL DEFAULT false, canceled_at timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_provider_id
 ON public.organization_subscriptions(billing_provider,provider_subscription_id)
 WHERE provider_subscription_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.subscription_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 subscription_id uuid REFERENCES public.organization_subscriptions(id) ON DELETE SET NULL,
 provider_event_id text UNIQUE, event_type text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb, processed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
 notification_type text NOT NULL, title text NOT NULL, body text NOT NULL DEFAULT '',
 payload jsonb NOT NULL DEFAULT '{}'::jsonb, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications(user_id,created_at DESC) WHERE read_at IS NULL;
CREATE TABLE IF NOT EXISTS public.notification_preferences (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 email_enabled boolean NOT NULL DEFAULT true, in_app_enabled boolean NOT NULL DEFAULT true,
 push_enabled boolean NOT NULL DEFAULT false, preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.backup_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
 initiated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 backup_type text NOT NULL DEFAULT 'manual' CHECK(backup_type IN ('manual','scheduled','pre_migration')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 storage_path text, checksum_sha256 text, record_count bigint, size_bytes bigint, error_message text,
 started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.security_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
 event_type text NOT NULL, ip_address inet, user_agent text,
 details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.platform_feature_flags (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flag_key text NOT NULL UNIQUE,
 description text NOT NULL DEFAULT '', is_enabled boolean NOT NULL DEFAULT false,
 rollout_percentage integer NOT NULL DEFAULT 0 CHECK(rollout_percentage BETWEEN 0 AND 100),
 config jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS ip_address inet;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS user_agent text;

CREATE OR REPLACE FUNCTION private.is_org_member(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT auth.uid() IS NOT NULL AND EXISTS(
 SELECT 1 FROM public.organization_members m
 WHERE m.organization_id=p_org_id AND m.user_id=auth.uid() AND m.status='active'
); $$;
CREATE OR REPLACE FUNCTION private.has_org_role(p_org_id uuid,p_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT auth.uid() IS NOT NULL AND EXISTS(
 SELECT 1 FROM public.organization_members m
 WHERE m.organization_id=p_org_id AND m.user_id=auth.uid()
 AND m.status='active' AND m.role=ANY(p_roles)
); $$;
REVOKE ALL ON FUNCTION private.is_org_member(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION private.has_org_role(uuid,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.is_org_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.has_org_role(uuid,text[]) TO authenticated;

CREATE OR REPLACE FUNCTION private.add_creator_as_org_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ BEGIN
 IF auth.uid() IS NOT NULL THEN
  INSERT INTO public.organization_members(organization_id,user_id,role,status,joined_at)
  VALUES(NEW.id,auth.uid(),'owner','active',now())
  ON CONFLICT(organization_id,user_id) DO NOTHING;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.add_creator_as_org_owner() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_add_creator_as_org_owner ON public.organizations;
CREATE TRIGGER trg_add_creator_as_org_owner AFTER INSERT ON public.organizations
FOR EACH ROW EXECUTE FUNCTION private.add_creator_as_org_owner();

CREATE OR REPLACE FUNCTION private.create_profile_for_auth_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ BEGIN
 INSERT INTO public.user_profiles(id,full_name)
 VALUES(NEW.id,COALESCE(NEW.raw_user_meta_data->>'full_name',''))
 ON CONFLICT(id) DO NOTHING;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.create_profile_for_auth_user() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_create_profile_for_auth_user ON auth.users;
CREATE TRIGGER trg_create_profile_for_auth_user AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION private.create_profile_for_auth_user();

-- Tighten search_path for the existing timestamp trigger function.
ALTER FUNCTION public.set_updated_at() SET search_path=pg_catalog;

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_tax_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_feature_flags ENABLE ROW LEVEL SECURITY;

-- Profile self-service.
CREATE POLICY profile_self_select ON public.user_profiles FOR SELECT TO authenticated USING(id=(SELECT auth.uid()));
CREATE POLICY profile_self_update ON public.user_profiles FOR UPDATE TO authenticated USING(id=(SELECT auth.uid())) WITH CHECK(id=(SELECT auth.uid()));
-- Organization membership.
CREATE POLICY org_member_select ON public.organization_members FOR SELECT TO authenticated
 USING(user_id=(SELECT auth.uid()) OR private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY org_member_admin_insert ON public.organization_members FOR INSERT TO authenticated
 WITH CHECK(role<>'owner' AND private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY org_member_admin_update ON public.organization_members FOR UPDATE TO authenticated
 USING(role<>'owner' AND private.has_org_role(organization_id,ARRAY['owner','admin']))
 WITH CHECK(role<>'owner' AND private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY org_member_admin_delete ON public.organization_members FOR DELETE TO authenticated
 USING(role<>'owner' AND private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY orgs_member_select ON public.organizations FOR SELECT TO authenticated USING(private.is_org_member(id));
CREATE POLICY orgs_authenticated_insert ON public.organizations FOR INSERT TO authenticated WITH CHECK((SELECT auth.uid()) IS NOT NULL);
CREATE POLICY orgs_admin_update ON public.organizations FOR UPDATE TO authenticated
 USING(private.has_org_role(id,ARRAY['owner','admin'])) WITH CHECK(private.has_org_role(id,ARRAY['owner','admin']));
CREATE POLICY orgs_owner_delete ON public.organizations FOR DELETE TO authenticated USING(private.has_org_role(id,ARRAY['owner']));

-- Existing invoice records are visible only to active members of their organization.
CREATE POLICY invoices_member_select ON public.invoices FOR SELECT TO authenticated USING(private.is_org_member(organization_id));
CREATE POLICY invoices_staff_insert ON public.invoices FOR INSERT TO authenticated
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant','sales','employee']));
CREATE POLICY invoices_staff_update ON public.invoices FOR UPDATE TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant','sales','employee']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant','sales','employee']));
CREATE POLICY invoices_admin_delete ON public.invoices FOR DELETE TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY invoice_items_member_select ON public.invoice_items FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.is_org_member(i.organization_id)));
CREATE POLICY invoice_items_staff_write ON public.invoice_items FOR ALL TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant','sales','employee'])))
 WITH CHECK(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant','sales','employee'])));
CREATE POLICY attachments_member_select ON public.invoice_attachments FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.is_org_member(i.organization_id)));
CREATE POLICY attachments_staff_write ON public.invoice_attachments FOR ALL TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant','sales','employee'])))
 WITH CHECK(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant','sales','employee'])));
CREATE POLICY custom_fields_member_select ON public.custom_fields FOR SELECT TO authenticated USING(private.is_org_member(organization_id));
CREATE POLICY custom_fields_admin_write ON public.custom_fields FOR ALL TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']));
CREATE POLICY invoice_custom_values_member_select ON public.invoice_custom_values FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.is_org_member(i.organization_id)));
CREATE POLICY invoice_custom_values_staff_write ON public.invoice_custom_values FOR ALL TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant','sales','employee'])))
 WITH CHECK(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant','sales','employee'])));
CREATE POLICY templates_authenticated_read ON public.template_versions FOR SELECT TO authenticated USING(true);
CREATE POLICY export_batches_member_select ON public.export_batches FOR SELECT TO authenticated USING(private.is_org_member(organization_id));
CREATE POLICY export_batches_accounting_write ON public.export_batches FOR ALL TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']));
CREATE POLICY export_batch_items_member_select ON public.export_batch_items FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.export_batches b WHERE b.id=export_batch_id AND private.is_org_member(b.organization_id)));
CREATE POLICY export_batch_items_accounting_write ON public.export_batch_items FOR ALL TO authenticated
 USING(EXISTS(SELECT 1 FROM public.export_batches b WHERE b.id=export_batch_id AND private.has_org_role(b.organization_id,ARRAY['owner','admin','accountant'])))
 WITH CHECK(EXISTS(SELECT 1 FROM public.export_batches b WHERE b.id=export_batch_id AND private.has_org_role(b.organization_id,ARRAY['owner','admin','accountant'])));
CREATE POLICY audit_logs_admin_select ON public.audit_logs FOR SELECT TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']));

-- New tenant-owned records.
CREATE POLICY customers_member_read ON public.customers FOR SELECT TO authenticated USING(private.is_org_member(organization_id));
CREATE POLICY customers_staff_write ON public.customers FOR ALL TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant','sales','employee']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant','sales','employee']));
CREATE POLICY suppliers_member_read ON public.suppliers FOR SELECT TO authenticated USING(private.is_org_member(organization_id));
CREATE POLICY suppliers_accounting_write ON public.suppliers FOR ALL TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']));
CREATE POLICY expense_categories_member_read ON public.expense_categories FOR SELECT TO authenticated USING(private.is_org_member(organization_id));
CREATE POLICY expense_categories_admin_write ON public.expense_categories FOR ALL TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']));
CREATE POLICY expenses_accounting_access ON public.expenses FOR ALL TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']));
CREATE POLICY payments_member_read ON public.invoice_payments FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.is_org_member(i.organization_id)));
CREATE POLICY payments_accounting_write ON public.invoice_payments FOR ALL TO authenticated
 USING(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant'])))
 WITH CHECK(EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND private.has_org_role(i.organization_id,ARRAY['owner','admin','accountant'])));
CREATE POLICY tax_settings_member_read ON public.organization_tax_settings FOR SELECT TO authenticated USING(private.is_org_member(organization_id));
CREATE POLICY tax_settings_admin_write ON public.organization_tax_settings FOR ALL TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']))
 WITH CHECK(private.has_org_role(organization_id,ARRAY['owner','admin','accountant']));
CREATE POLICY plans_active_read ON public.subscription_plans FOR SELECT TO authenticated USING(is_active);
CREATE POLICY subscriptions_admin_read ON public.organization_subscriptions FOR SELECT TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY subscription_events_admin_read ON public.subscription_events FOR SELECT TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY invitations_admin_read ON public.organization_invitations FOR SELECT TO authenticated
 USING(private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY notifications_self_read ON public.notifications FOR SELECT TO authenticated USING(user_id=(SELECT auth.uid()));
CREATE POLICY notifications_self_update ON public.notifications FOR UPDATE TO authenticated
 USING(user_id=(SELECT auth.uid())) WITH CHECK(user_id=(SELECT auth.uid()));
CREATE POLICY notification_preferences_self_access ON public.notification_preferences FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid())) WITH CHECK(user_id=(SELECT auth.uid()));
CREATE POLICY backups_admin_read ON public.backup_runs FOR SELECT TO authenticated
 USING(organization_id IS NOT NULL AND private.has_org_role(organization_id,ARRAY['owner','admin']));
CREATE POLICY security_events_self_read ON public.security_events FOR SELECT TO authenticated USING(user_id=(SELECT auth.uid()));
CREATE POLICY feature_flags_enabled_read ON public.platform_feature_flags FOR SELECT TO authenticated USING(is_enabled);

GRANT SELECT,INSERT,UPDATE,DELETE ON
 public.user_profiles,public.organization_members,public.organization_invitations,
 public.customers,public.suppliers,public.expense_categories,public.expenses,
 public.invoice_payments,public.organization_tax_settings,public.subscription_plans,
 public.organization_subscriptions,public.subscription_events,public.notifications,
 public.notification_preferences,public.backup_runs,public.security_events,
 public.platform_feature_flags,public.organizations,public.invoices,public.invoice_items,
 public.invoice_attachments,public.custom_fields,public.invoice_custom_values,
 public.template_versions,public.export_batches,public.export_batch_items,public.audit_logs
 TO authenticated;
REVOKE ALL ON public.app_settings,public.ai_extraction_logs FROM anon,authenticated;

-- Storage objects are private; paths are organization UUID / invoice UUID / filename.
CREATE POLICY invoice_images_member_select ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='invoice-images' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.is_org_member(split_part(name,'/',1)::uuid) ELSE false END);
CREATE POLICY invoice_images_staff_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='invoice-images' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.has_org_role(split_part(name,'/',1)::uuid,ARRAY['owner','admin','accountant','sales','employee']) ELSE false END);
CREATE POLICY invoice_images_staff_update ON storage.objects FOR UPDATE TO authenticated
 USING(bucket_id='invoice-images' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.has_org_role(split_part(name,'/',1)::uuid,ARRAY['owner','admin','accountant','sales','employee']) ELSE false END)
 WITH CHECK(bucket_id='invoice-images' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.has_org_role(split_part(name,'/',1)::uuid,ARRAY['owner','admin','accountant','sales','employee']) ELSE false END);
CREATE POLICY invoice_images_admin_delete ON storage.objects FOR DELETE TO authenticated
 USING(bucket_id='invoice-images' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.has_org_role(split_part(name,'/',1)::uuid,ARRAY['owner','admin']) ELSE false END);
CREATE POLICY invoice_exports_member_select ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='invoice-exports' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.is_org_member(split_part(name,'/',1)::uuid) ELSE false END);
CREATE POLICY invoice_exports_accounting_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='invoice-exports' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.has_org_role(split_part(name,'/',1)::uuid,ARRAY['owner','admin','accountant']) ELSE false END);
CREATE POLICY invoice_exports_admin_delete ON storage.objects FOR DELETE TO authenticated
 USING(bucket_id='invoice-exports' AND CASE WHEN split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN private.has_org_role(split_part(name,'/',1)::uuid,ARRAY['owner','admin']) ELSE false END);

-- Index the previously identified missing foreign-key lookups.
CREATE INDEX IF NOT EXISTS idx_invoice_custom_values_custom_field_id ON public.invoice_custom_values(custom_field_id);
CREATE INDEX IF NOT EXISTS idx_export_batch_items_invoice_id_fk ON public.export_batch_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_invoice_id_fk ON public.audit_logs(invoice_id);
