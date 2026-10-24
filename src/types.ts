export type RelationshipCategory = 'Family' | 'Friends' | 'Work' | 'Mentors';

export interface Contact {
  id?: string;
  name: string;
  category: RelationshipCategory;
  notes?: string;
  created_at?: string;
}

export type AttentionGoals = Record<RelationshipCategory, number>;

export interface ExtractResult {
  name: string | null;
  contacts: Contact[];
  goals: AttentionGoals;
  action: 'confirm' | null;
  source?: 'rules' | 'gemini' | 'openai' | 'voice AI' | 'live voice';
  saved?: boolean;
}

export interface VoiceConfig {
  enabled: boolean;
  mode: 'signed' | 'public' | 'off';
  agent_id?: string | null;
}

export interface SignedUrlResponse {
  signed_url: string;
}

export interface RoomParticipant {
  id: string;
  name: string;
  budget?: string;
  area?: string;
  availability?: string[];
  joined_at?: string;
}

export interface VenueOption {
  id: string;
  name: string;
  area?: string;
  votes: string[];
}

export interface MeetupRoom {
  token: string;
  title: string;
  when: string;
  status: 'open' | 'confirmed' | 'closed';
  is_organizer: boolean;
  organizer_key?: string | null;
  participants: RoomParticipant[];
  shortlist: VenueOption[];
  confirmed_venue_id?: string | null;
}
