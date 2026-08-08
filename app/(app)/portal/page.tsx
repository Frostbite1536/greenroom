import { requireSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { resolveSessionUser } from "@/lib/portal/user";
import { ProfileForm, type PortalProfile } from "./profile-form";
import { TaskChecklist, type PortalTask } from "./task-checklist";
import styles from "./portal.module.css";

export const dynamic = "force-dynamic";

function formatSlot(startsAt: Date | null, endsAt: Date | null, room: string | null, timezone: string): string {
  if (!startsAt || !endsAt) return "Not scheduled yet";
  const day = startsAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: timezone });
  const opts = { hour: "numeric", minute: "2-digit", timeZone: timezone } as const;
  const window = `${startsAt.toLocaleTimeString("en-US", opts)} – ${endsAt.toLocaleTimeString("en-US", opts)}`;
  return room ? `${day}, ${window} · ${room}` : `${day}, ${window}`;
}

export default async function PortalPage() {
  const session = await requireSession();
  const user = await resolveSessionUser(session);
  if (!user) redirect("/login");
  const eventId = session.event.id;

  // One round trip per concern, issued in parallel to avoid a request waterfall.
  const [profile, speakerTasks, sessionSpeakers, abstracts, resources, event] = await Promise.all([
    prisma.speakerProfile.findUnique({
      where: { userId: user.id },
      select: { bio: true, company: true, jobTitle: true, headshotUrl: true, slideDeckUrl: true },
    }),
    prisma.speakerTask.findMany({
      where: { userId: user.id, task: { eventId } },
      select: {
        status: true,
        task: { select: { id: true, title: true, description: true, required: true, dueAt: true, formConfigId: true, sortOrder: true } },
      },
      orderBy: { task: { sortOrder: "asc" } },
    }),
    prisma.sessionSpeaker.findMany({
      where: { userId: user.id, session: { eventId } },
      select: {
        session: {
          select: {
            id: true,
            title: true,
            format: true,
            durationMinutes: true,
            scheduleSlot: { select: { startsAt: true, endsAt: true, room: { select: { name: true } } } },
          },
        },
      },
    }),
    prisma.abstract.findMany({
      where: { eventId, speakers: { some: { userId: user.id } } },
      select: { id: true, title: true, status: true, submittedAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.resourceWiki.findMany({
      where: { eventId, published: true },
      select: { id: true, slug: true, title: true, summary: true },
      orderBy: { title: "asc" },
    }),
    prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true } }),
  ]);
  const timezone = event?.timezone ?? "UTC";

  const tasks: PortalTask[] = speakerTasks.map((row) => ({
    taskId: row.task.id,
    title: row.task.title,
    description: row.task.description,
    required: row.task.required,
    dueAt: row.task.dueAt ? row.task.dueAt.toISOString() : null,
    hasForm: row.task.formConfigId !== null,
    status: row.status,
  }));

  const initialProfile: PortalProfile = {
    bio: profile?.bio ?? "",
    company: profile?.company ?? "",
    jobTitle: profile?.jobTitle ?? "",
    headshotUrl: profile?.headshotUrl ?? "",
    slideDeckUrl: profile?.slideDeckUrl ?? "",
  };

  const sessions = sessionSpeakers.map((s) => s.session);
  const doneCount = tasks.filter((t) => t.status === "COMPLETED" || t.status === "WAIVED").length;

  // Profile completeness drives the headline metric speakers see first.
  const profileFields = [initialProfile.bio, initialProfile.company, initialProfile.jobTitle, initialProfile.headshotUrl];
  const profilePct = Math.round((profileFields.filter((v) => v.trim().length > 0).length / profileFields.length) * 100);

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Speaker workspace</p>
          <h1>Welcome back, {user.name.split(" ")[0]}</h1>
          <p>Keep your profile, sessions, and required tasks for {session.event.name} in one place.</p>
        </div>
      </header>

      <div className="metric-grid">
        <div className="metric"><span>Profile</span><strong>{profilePct}%</strong></div>
        <div className="metric"><span>Tasks complete</span><strong>{doneCount} / {tasks.length}</strong></div>
        <div className="metric"><span>Confirmed sessions</span><strong>{sessions.length}</strong></div>
      </div>

      <div className={styles.grid}>
        <div>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2>Your tasks</h2>
                <p>Everything the program team needs from you before the event.</p>
              </div>
            </div>
            <TaskChecklist tasks={tasks} />
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2>Your sessions</h2>
                <p>Confirmed talks and their schedule status.</p>
              </div>
            </div>
            {sessions.length === 0 ? (
              <p className={styles.empty}>No confirmed sessions yet. Accepted submissions appear here.</p>
            ) : (
              sessions.map((s) => (
                <div className={styles.sessionItem} key={s.id}>
                  <div className={styles.sessionTitle}>{s.title}</div>
                  <p className={styles.sessionMeta}>
                    {s.format ?? "Session"} · {s.durationMinutes} min
                  </p>
                  <p className={styles.sessionMeta}>
                    {formatSlot(
                        s.scheduleSlot?.startsAt ?? null,
                        s.scheduleSlot?.endsAt ?? null,
                        s.scheduleSlot?.room.name ?? null,
                        timezone,
                    )}
                  </p>
                </div>
              ))
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2>Your submissions</h2>
                <p>Every abstract you are listed on.</p>
              </div>
            </div>
            {abstracts.length === 0 ? (
              <p className={styles.empty}>You have no submissions for this event.</p>
            ) : (
              abstracts.map((a) => (
                <div className={styles.sessionItem} key={a.id}>
                  <div className={styles.sessionTitle}>{a.title}</div>
                  <p className={styles.sessionMeta}>
                    {a.status.replace(/_/g, " ").toLowerCase()}
                    {a.submittedAt ? ` · submitted ${a.submittedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : ""}
                  </p>
                </div>
              ))
            )}
          </section>
        </div>

        <div>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2>Your profile</h2>
                <p>Used on the public site and in the program.</p>
              </div>
            </div>
            <ProfileForm profile={initialProfile} />
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2>Resources</h2>
                <p>Speaker handbook and logistics.</p>
              </div>
            </div>
            {resources.length === 0 ? (
              <p className={styles.empty}>No resources published yet.</p>
            ) : (
              resources.map((r) => (
                <a className={styles.resourceLink} href={`/portal/resources/${r.slug}`} key={r.id}>
                  {r.title}
                  {r.summary ? <span className={styles.resourceSummary}>{r.summary}</span> : null}
                </a>
              ))
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
