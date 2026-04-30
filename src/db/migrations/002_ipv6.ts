import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ip_ranges_v6')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('provider_id', 'text', (c) =>
      c.notNull().references('providers.id').onDelete('cascade'),
    )
    .addColumn('start_ip', 'blob', (c) => c.notNull())
    .addColumn('end_ip', 'blob', (c) => c.notNull())
    .addColumn('cidr', 'text')
    .execute();

  await db.schema
    .createIndex('idx_ip_ranges_v6_lookup')
    .on('ip_ranges_v6')
    .columns(['start_ip', 'end_ip'])
    .execute();

  await db.schema
    .createIndex('idx_ip_ranges_v6_provider')
    .on('ip_ranges_v6')
    .columns(['provider_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ip_ranges_v6').ifExists().execute();
}
