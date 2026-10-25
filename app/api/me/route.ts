import { handle, ok, requireUser } from '@/lib/http';

// GET /api/me -> the signed-in account's own details, shown on the Profile page.
export const GET = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  return ok({ user: { email: user.email ?? null, created_at: user.created_at ?? null } });
});
