import { sheetsDisconnect } from '@/lib/google/sheets-routes';
export const runtime = 'nodejs';
export const POST = sheetsDisconnect('import');
