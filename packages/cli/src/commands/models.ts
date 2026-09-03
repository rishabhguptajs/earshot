import { buildRegistry, fetchCatalog, ModelCatalog } from '@earshot/providers';
import type { ParsedArgs } from '../args.ts';

/** `earshot models [filter] [--refresh] [--json]` */
export async function modelsCommand(args: ParsedArgs): Promise<number> {
  const catalog = args.flags.refresh ? new ModelCatalog(await fetchCatalog()) : new ModelCatalog();
  const registry = buildRegistry({ catalog });

  const filter = args.positionals[0]?.toLowerCase();
  const models = registry
    .models()
    .filter(
      (m) =>
        !filter ||
        m.id.toLowerCase().includes(filter) ||
        m.providerId.toLowerCase().includes(filter) ||
        m.name.toLowerCase().includes(filter),
    );

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return 0;
  }

  if (models.length === 0) {
    process.stderr.write(`no models match "${filter}"\n`);
    return 1;
  }

  const rows = models.map((m) => ({
    ref: `${m.providerId}/${m.id}`,
    context: `${Math.round(m.contextWindow / 1000)}k`,
    price: m.cost ? `$${m.cost.input}/$${m.cost.output}` : '-',
    tags: [
      m.capabilities.reasoning ? 'reasoning' : '',
      m.capabilities.vision ? 'vision' : '',
      m.capabilities.tools ? '' : 'no-tools',
    ]
      .filter(Boolean)
      .join(' '),
  }));

  const width = Math.max(...rows.map((r) => r.ref.length));
  const priceWidth = Math.max(...rows.map((r) => r.price.length));
  for (const row of rows) {
    process.stdout.write(
      `${row.ref.padEnd(width)}  ${row.context.padStart(6)}  ${row.price.padStart(priceWidth)}  ${row.tags}\n`,
    );
  }
  process.stdout.write(
    `\n${models.length} models across ${new Set(models.map((m) => m.providerId)).size} providers`,
  );
  process.stdout.write(` (catalog ${catalog.generatedAt.slice(0, 10)})\n`);
  process.stdout.write('prices are USD per million tokens, input/output\n');
  return 0;
}
