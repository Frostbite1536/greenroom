import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
async function main() {
  const cats = await p.category.findMany({ where: { eventId: "demo-event" }, select: { name: true } });
  console.log("categories:", cats.length, JSON.stringify(cats.map((c) => c.name)));
  const [a, s, sl, f] = await Promise.all([
    p.abstract.count({ where: { eventId: "demo-event" } }),
    p.session.count({ where: { eventId: "demo-event" } }),
    p.scheduleSlot.count({ where: { eventId: "demo-event" } }),
    p.formConfig.count({ where: { eventId: "demo-event" } }),
  ]);
  console.log("abstracts:", a, "sessions:", s, "slots:", sl, "forms:", f);
}
main().finally(() => p.$disconnect());
// (extended checks appended by architect)
