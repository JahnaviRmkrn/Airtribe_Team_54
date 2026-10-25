import { redirect } from 'next/navigation';
import { userClient } from '@/lib/supabase/server';
import SheetsClient from './SheetsClient';
import './sheets.css';

export const dynamic = 'force-dynamic';
export default async function GoogleSheetsPage() {
  const { data } = await (await userClient()).auth.getUser();
  if (!data.user) redirect('/login?next=%2Fintegrations%2Fgoogle-sheets');
  return <SheetsClient />;
}
