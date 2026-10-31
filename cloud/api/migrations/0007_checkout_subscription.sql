ALTER TABLE billing_checkouts ADD COLUMN subscription_id TEXT;
CREATE INDEX billing_checkout_subscription ON billing_checkouts(org_id,subscription_id);
