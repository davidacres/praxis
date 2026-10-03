/** The five specialist seats on the virtual engineering team. */
export type AssistantRole = 'lead' | 'dev' | 'qa' | 'security' | 'product';

/** Who authored a message in a team chat. */
export type AssistantSpeaker = AssistantRole | 'user';

/** The kind of surface a page context describes. */
export type AssistantPageType = 'board' | 'issue' | 'git' | 'workflow' | 'workflow-run' | 'project' | 'general';

export interface AssistantPersona {
  id: AssistantRole;
  /** Display name, e.g. "QA Specialist". */
  name: string;
  /** Short badge text, e.g. "QA". */
  badge: string;
  role: AssistantRole;
  /** A renderer `IconName`; kept a plain string so core stays UI-free. */
  icon: string;
  /** Names a `--persona-<tone>` colour token in the renderer's theme. */
  tone: AssistantRole;
  systemPrompt: string;
}

/** What the page the user is looking at advertises to the assistant. */
export interface PageAssistantContext {
  pageType: AssistantPageType;
  /** Short label for the context pill, e.g. "Issue PRX-12". */
  title: string;
  /** One or two lines the model reads first. */
  summary: string;
  /** Serialized page state (markdown/JSON text). Truncated before it is sent. */
  data?: string;
  projectId?: string;
  issueKey?: string;
  /** Quick prompts shown as chips. */
  suggestedPrompts?: string[];
}

export interface AssistantChoiceOption {
  label: string;
  /** Sent back into the conversation as the user's next message. */
  prompt: string;
}

export type AssistantProposedAction =
  | { kind: 'update-workflow'; label: string; summary: string; workflow: unknown }
  | { kind: 'update-ticket'; label: string; summary: string; description: string }
  | { kind: 'delegate-session'; label: string; summary: string; prompt: string };

export interface AssistantMessage {
  id: string;
  role: AssistantSpeaker;
  text: string;
  createdAt: string;
  /** Page the message was written against, for the feed's context hint. */
  contextTitle?: string;
  choices?: AssistantChoiceOption[];
  proposedAction?: AssistantProposedAction;
  /** Set on a failed turn so the feed can style it as an error. */
  error?: boolean;
}

export interface AssistantTurnRequest {
  message: string;
  /** Persona to answer when the message carries no `@mention`. Defaults to `lead`. */
  personaId?: AssistantRole;
  context?: PageAssistantContext;
  history?: readonly AssistantMessage[];
}

export interface AssistantTurnResult {
  messages: AssistantMessage[];
}

export interface AssistantTeamReviewRequest {
  prompt?: string;
  context?: PageAssistantContext;
  history?: readonly AssistantMessage[];
}

export interface TeamChatRecord {
  id: string;
  projectId: string;
  title: string;
  issueKey?: string;
  createdAt: string;
  updatedAt: string;
  messages: AssistantMessage[];
}

/** A chat without its transcript, for the sidebar list. */
export type TeamChatSummary = Omit<TeamChatRecord, 'messages'> & { messageCount: number; personas: AssistantRole[] };
