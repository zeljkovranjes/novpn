import { closeDb } from '../db/db.js';
import { runMigrations } from '../db/migrate.js';
import { seedIfEmpty } from '../db/seed.js';
import { refreshAllProviders, refreshProvider } from '../services/providers.js';

async function main() {
  await runMigrations('up');
  await seedIfEmpty();
  const id = process.argv[2];
  if (id) {
    const result = await refreshProvider(id);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const results = await refreshAllProviders();
    console.log(JSON.stringify({ results }, null, 2));
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
