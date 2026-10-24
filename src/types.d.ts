type RelationshipCategory = 'Family' | 'Friends' | 'Work' | 'Mentors';

interface Contact {
  id?: string;
  name: string;
  category: RelationshipCategory;
  notes?: string;
  created_at?: string;
}

type AttentionGoals = Record<RelationshipCategory, number>;

interface ExtractResult {
  name: string | null;
  contacts: Contact[];
  goals: AttentionGoals;
  action: 'confirm' | null;
  source?: 'rules' | 'gemini' | 'openai' | 'voice AI' | 'live voice';
  saved?: boolean;
}

interface VoiceConfig {
  enabled: boolean;
  mode: 'signed' | 'public' | 'off';
  agent_id?: string | null;
}

interface SignedUrlResponse {
  signed_url: string;
}

interface Window {
  Voice?: {
    mount: (root: HTMLElement, onResult: (res: ExtractResult) => void) => { stop: () => void };
  };
  __poll?: any;
}
