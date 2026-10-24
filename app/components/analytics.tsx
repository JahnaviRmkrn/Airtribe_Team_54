'use client';
import { Analytics } from '@vercel/analytics/react';

// Never send auth codes, room tokens, query strings or onboarding text.
export function ProductAnalytics() {
  return <Analytics beforeSend={(event) => {
    const url = new URL(event.url);
    if (!['/', '/login'].includes(url.pathname)) return null;
    url.search = '';
    url.hash = '';
    return { ...event, url: url.toString() };
  }} />;
}
