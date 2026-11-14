-- =============================================================================
-- Fawater Complete Database & Private Storage Schema (Idempotent Migration)
-- Target: Supabase PostgreSQL
-- Security: No users/profiles/auth dependency. RLS enabled on all tables with
--           NO public anon read/write/delete policies. All writes/reads go
--           through a trusted backend using SUPABASE_SERVICE_ROLE_KEY.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared updated_at trigger function
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 1. organizations
CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  activity_type TEXT NOT NULL DEFAULT 'أخرى',
  excel_file_name TEXT NOT NULL DEFAULT 'fawater_export.xlsx',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON public.organizations;
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 2. invoices
CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL CHECK (document_type IN ('مبيعات', 'مشتريات', 'يحتاج تحديد النوع')),
  entry_method TEXT CHECK (entry_method IN ('ai', 'manual')),
  invoice_number TEXT NOT NULL DEFAULT '',
  invoice_date DATE NULL,
  day TEXT NOT NULL DEFAULT '',
  issuer_name TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  issuer_tax_id TEXT NOT NULL DEFAULT '',
  client_tax_id TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  subtotal NUMERIC(14, 2) NULL,
  tax_amount NUMERIC(14, 2) NULL,
  tax_rate NUMERIC(7, 4) NULL,
  discount NUMERIC(14, 2) NULL,
  grand_total NUMERIC(14, 2) NULL,
  cash_sales NUMERIC(14, 2) NULL,
  network_sales NUMERIC(14, 2) NULL,
  cash_balance NUMERIC(14, 2) NULL,
  cash_box_balance NUMERIC(14, 2) NULL,
  network_balance NUMERIC(14, 2) NULL,
  balance NUMERIC(14, 2) NULL,
  notes TEXT NOT NULL DEFAULT '',
  classification_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('لم تبدأ', 'قيد المعالجة', 'تحتاج مراجعة', 'مكتملة', 'فشل')),
  error_message TEXT NULL,
  custom_fields_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra_columns_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_organization_id ON public.invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_doc_type ON public.invoices(document_type);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON public.invoices(invoice_date);

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON public.invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 3. invoice_items
CREATE TABLE IF NOT EXISTS public.invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  code TEXT NULL,
  quantity NUMERIC(14, 4) NULL,
  unit TEXT NULL,
  unit_price NUMERIC(14, 2) NULL,
  discount NUMERIC(14, 2) NULL,
  tax NUMERIC(14, 2) NULL,
  total NUMERIC(14, 2) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON public.invoice_items(invoice_id);

-- 4. invoice_attachments
CREATE TABLE IF NOT EXISTS public.invoice_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  file_size BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_attachment_path UNIQUE (invoice_id, storage_path)
);

CREATE INDEX IF NOT EXISTS idx_invoice_attachments_invoice_id ON public.invoice_attachments(invoice_id);

-- 5. custom_fields
CREATE TABLE IF NOT EXISTS public.custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  field_type TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT false,
  ai_extract BOOLEAN NOT NULL DEFAULT true,
  manual_entry BOOLEAN NOT NULL DEFAULT true,
  excel_sheet TEXT NOT NULL,
  excel_column TEXT NOT NULL,
  options JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_fields_organization_id ON public.custom_fields(organization_id);

DROP TRIGGER IF EXISTS trg_custom_fields_updated_at ON public.custom_fields;
CREATE TRIGGER trg_custom_fields_updated_at
  BEFORE UPDATE ON public.custom_fields
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 6. invoice_custom_values
CREATE TABLE IF NOT EXISTS public.invoice_custom_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  custom_field_id UUID NOT NULL REFERENCES public.custom_fields(id) ON DELETE CASCADE,
  value JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_custom_field UNIQUE (invoice_id, custom_field_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_custom_values_invoice_id ON public.invoice_custom_values(invoice_id);

DROP TRIGGER IF EXISTS trg_invoice_custom_values_updated_at ON public.invoice_custom_values;
CREATE TRIGGER trg_invoice_custom_values_updated_at
  BEFORE UPDATE ON public.invoice_custom_values
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 7. template_versions
CREATE TABLE IF NOT EXISTS public.template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_template_versions_sha256 UNIQUE (sha256)
);

-- 8. export_batches
CREATE TABLE IF NOT EXISTS public.export_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  template_sha256 TEXT NOT NULL,
  template_version_id UUID NULL REFERENCES public.template_versions(id) ON DELETE SET NULL,
  storage_path TEXT NULL,
  exported_count INTEGER NOT NULL DEFAULT 0,
  sales_count INTEGER NOT NULL DEFAULT 0,
  purchases_count INTEGER NOT NULL DEFAULT 0,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_export_batches_organization_id ON public.export_batches(organization_id);
CREATE INDEX IF NOT EXISTS idx_export_batches_exported_at ON public.export_batches(exported_at DESC);

-- 9. export_batch_items
CREATE TABLE IF NOT EXISTS public.export_batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_batch_id UUID NOT NULL REFERENCES public.export_batches(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  sheet_name TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_export_batch_invoice UNIQUE (export_batch_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_export_batch_items_batch_id ON public.export_batch_items(export_batch_id);
CREATE INDEX IF NOT EXISTS idx_export_batch_items_invoice_id ON public.export_batch_items(invoice_id);

-- 10. ai_extraction_logs
CREATE TABLE IF NOT EXISTS public.ai_extraction_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'gemini',
  model_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error_message TEXT NULL,
  extracted_data JSONB NULL,
  processing_time_ms INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_extraction_logs_invoice_id ON public.ai_extraction_logs(invoice_id);

-- 11. audit_logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  invoice_id UUID NULL REFERENCES public.invoices(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_organization_id ON public.audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- 12. app_settings
CREATE TABLE IF NOT EXISTS public.app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key TEXT NOT NULL UNIQUE,
  setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON public.app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- Row Level Security (RLS)
-- Strictly deny anonymous/public access. Service role on the trusted backend
-- bypasses RLS automatically.
-- =============================================================================
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_extraction_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke default public/anon table privileges for defense in depth
REVOKE ALL ON TABLE
  public.organizations,
  public.invoices,
  public.invoice_items,
  public.invoice_attachments,
  public.custom_fields,
  public.invoice_custom_values,
  public.template_versions,
  public.export_batches,
  public.export_batch_items,
  public.ai_extraction_logs,
  public.audit_logs,
  public.app_settings
FROM anon, public;

-- =============================================================================
-- Private Storage Buckets (invoice-images, invoice-exports)
-- =============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'invoice-images',
    'invoice-images',
    false,
    15728640,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  ),
  (
    'invoice-exports',
    'invoice-exports',
    false,
    26214400,
    ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  )
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
