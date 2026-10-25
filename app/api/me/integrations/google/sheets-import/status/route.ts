import { sheetsStatus } from '@/lib/google/sheets-routes';
export const runtime = 'nodejs';
export const GET = sheetsStatus('import');
