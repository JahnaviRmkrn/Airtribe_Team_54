import { sheetsCallback } from '@/lib/google/sheets-routes';
export const runtime = 'nodejs';
export const GET = sheetsCallback('export');
