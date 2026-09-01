-- Hold allocations must reference both the tenant and the parent identifier;
-- an identifier copied across tenants must fail closed at the database edge.
ALTER TABLE entitlement_credit_hold
  ADD CONSTRAINT uq_entitlement_credit_hold_tenant_id UNIQUE (tenant_id, credit_hold_id);
ALTER TABLE entitlement_credit_grant
  ADD CONSTRAINT uq_entitlement_credit_grant_tenant_id UNIQUE (tenant_id, credit_grant_id);
ALTER TABLE entitlement_credit_hold_allocation
  DROP CONSTRAINT fk_entitlement_hold_allocation_hold,
  DROP CONSTRAINT fk_entitlement_hold_allocation_grant;
ALTER TABLE entitlement_credit_hold_allocation
  ADD CONSTRAINT fk_entitlement_hold_allocation_hold_tenant
    FOREIGN KEY (tenant_id, credit_hold_id)
    REFERENCES entitlement_credit_hold (tenant_id, credit_hold_id),
  ADD CONSTRAINT fk_entitlement_hold_allocation_grant_tenant
    FOREIGN KEY (tenant_id, credit_grant_id)
    REFERENCES entitlement_credit_grant (tenant_id, credit_grant_id);
