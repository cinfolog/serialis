-- Registry, installation fields of spec 11.1 (additive: the status CHECK of 0001 is kept,
-- 'inactive' stands for "uninstalled" until a later migration rebuilds the table, see workers/DECISIONS.md).
ALTER TABLE shops ADD COLUMN shopify_shop_gid TEXT;
ALTER TABLE shops ADD COLUMN plan TEXT;
ALTER TABLE shops ADD COLUMN install_count INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX shops_shopify_shop_gid ON shops (shopify_shop_gid) WHERE shopify_shop_gid IS NOT NULL;
