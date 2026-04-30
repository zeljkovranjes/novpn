import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('providers')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('category', 'text', (c) => c.notNull().defaultTo('vpn'))
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('sources', 'text', (c) => c.notNull())
    .addColumn('last_refresh_at', 'integer')
    .addColumn('last_refresh_status', 'text')
    .addColumn('created_at', 'integer', (c) => c.notNull())
    .addColumn('updated_at', 'integer', (c) => c.notNull())
    .execute();

  await db.schema
    .createIndex('idx_providers_category_enabled')
    .on('providers')
    .columns(['category', 'enabled'])
    .execute();

  await db.schema
    .createTable('ip_ranges')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('provider_id', 'text', (c) =>
      c.notNull().references('providers.id').onDelete('cascade'),
    )
    .addColumn('start_ip', 'integer', (c) => c.notNull())
    .addColumn('end_ip', 'integer', (c) => c.notNull())
    .addColumn('cidr', 'text')
    .execute();

  await db.schema
    .createIndex('idx_ip_ranges_lookup')
    .on('ip_ranges')
    .columns(['start_ip', 'end_ip'])
    .execute();

  await db.schema
    .createIndex('idx_ip_ranges_provider')
    .on('ip_ranges')
    .columns(['provider_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ip_ranges').ifExists().execute();
  await db.schema.dropTable('providers').ifExists().execute();
}
