// One rule for "overdue": the check-in's calendar day is before today, in
// Asia/Kolkata (muop is Bengaluru-only). A check-in due today is not overdue.
// The organizer UI uses the same day-based rule (public/organizer/app.js dueIn).
const TZ = 'Asia/Kolkata';
const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD

export function isOverdue(iso: string | null | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !isNaN(d.getTime()) && day(d) < day(now);
}
