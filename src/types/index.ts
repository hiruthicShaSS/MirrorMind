export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface SessionResponse {
  id: string;
  createdAt: string;
  messages: Message[];
  conceptMap: Record<string, string[]>;
  isActive: boolean;
  userId?: string;
}

export interface ParsedStructured {
  conceptMap: Record<string, string[]>;
  feasibilitySignal: number | null;
}

export interface SessionContextMessage {
  role: string;
  content: string;
}
