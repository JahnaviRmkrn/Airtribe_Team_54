export const roomUrl = (req: Request, token: string) =>
  `${process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin}/m/${token}`;
