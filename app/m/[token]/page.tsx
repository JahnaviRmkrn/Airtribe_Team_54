import type { Metadata } from 'next';
import RoomClient from './RoomClient';

export const metadata: Metadata = {
  title: 'Meetup room',
  description: 'Add your preferences and vote on a place for the meetup.',
};

// Guest-facing meetup room. Public: guests open /m/<token> from the invite
// link, add their preferences and vote. Nothing is sent to anyone from here.
export default function RoomPage() {
  return <RoomClient />;
}
