-- Preserve historical UV/PV. Behavior flags start at rollout, never infer history.
ALTER TABLE visitor_days ADD COLUMN product_view INTEGER NOT NULL DEFAULT 0 CHECK(product_view IN (0,1));
ALTER TABLE visitor_days ADD COLUMN checkout_view INTEGER NOT NULL DEFAULT 0 CHECK(checkout_view IN (0,1));
ALTER TABLE visitor_days ADD COLUMN payment_view INTEGER NOT NULL DEFAULT 0 CHECK(payment_view IN (0,1));
CREATE INDEX order_events_payment_analytics ON order_events(action,created_at,order_id);
