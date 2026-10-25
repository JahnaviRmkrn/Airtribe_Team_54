import { sheetsConnect } from '@/lib/google/sheets-routes';
export const runtime = 'nodejs';
export const POST = sheetsConnect('export');
