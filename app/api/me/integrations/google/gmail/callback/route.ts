import { actionRoutes } from '@/lib/google/action-routes';
export const runtime = 'nodejs';
export const GET = actionRoutes('gmail').callback;
