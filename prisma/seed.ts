import { PrismaClient } from "@prisma/client";
import { seedDemo } from "../lib/demo/seed";

/**
 * CLI entrypoint for the demo seed. Run with:
 *   npx tsx prisma/seed.ts
 * or (once package.json wires it up) `prisma db seed` / `npm run db:seed`.
 *
 * The seed is idempotent: it wipes and rebuilds all demo-event data on each run.
 */
async function main() {
  const prisma = new PrismaClient();
  try {
    console.log("Seeding demo data…");
    const summary = await seedDemo(prisma);
    console.table(summary);
    console.log("✓ Demo seed complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
