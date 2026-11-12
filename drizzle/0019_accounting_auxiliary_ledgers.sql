-- Phase 4.4: customer and supplier auxiliary dimensions on journal lines.
-- Tenant-safe references; a line may reference at most one third party.
ALTER TABLE public.suppliers
  ADD CONSTRAINT suppliers_business_id_id_unique UNIQUE (business_id, id);

ALTER TABLE public.accounting_entry_lines
  ADD COLUMN customer_id uuid,
  ADD COLUMN supplier_id uuid,
  ADD CONSTRAINT accounting_entry_lines_customer_fk
    FOREIGN KEY (business_id, customer_id) REFERENCES public.customers (business_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT accounting_entry_lines_supplier_fk
    FOREIGN KEY (business_id, supplier_id) REFERENCES public.suppliers (business_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT accounting_entry_lines_single_auxiliary_check
    CHECK (customer_id IS NULL OR supplier_id IS NULL);

CREATE INDEX accounting_entry_lines_customer_idx
  ON public.accounting_entry_lines (business_id, customer_id, entry_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX accounting_entry_lines_supplier_idx
  ON public.accounting_entry_lines (business_id, supplier_id, entry_id)
  WHERE supplier_id IS NOT NULL;
