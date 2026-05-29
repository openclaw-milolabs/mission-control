export type AdapterUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
};

export type AdapterSession = {
  accessToken: string;
  user: AdapterUser | null;
};

export type BoardRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  createdAt: string;
};

export type ColumnRecord = {
  id: string;
  boardId: string;
  title: string;
  colorKey: string | null;
  isDefault: boolean;
  position: number;
  createdAt: string;
};

export type TicketPriority = "low" | "medium" | "high" | "urgent";

export type TicketExecutionState =
  | "open"
  | "planning"
  | "awaiting_approval"
  | "ready_to_execute"
  | "executing"
  | "done"
  | "failed"
  | "expired"
  | "pending"
  | "queued"
  | "picked_up"
  | "running"
  | "draft"
  | "needs_retry";

export type TicketLifecycleState = TicketExecutionState;

export type TicketExecutionMode = "direct" | "planned";

export type TicketRecord = {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string;
  priority: TicketPriority;
  dueDate: string | null;
  tags: string[];
  assigneeIds: string[];
  assignedAgentId: string;
  executionMode: TicketExecutionMode;
  planText: string | null;
  planApproved: boolean;
  scheduledFor: string | null;
  executionState: TicketExecutionState;
  processVersionIds: string[];
  executionWindowMinutes: number;
  checklistDone: number;
  checklistTotal: number;
  attachmentsCount: number;
  commentsCount: number;
  position: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateBoardPayload = {
  name: string;
  description?: string;
  workspaceId?: string;
};

export type UpdateBoardPatch = {
  name?: string;
  description?: string;
};

export type CreateColumnPayload = {
  title: string;
  colorKey?: string | null;
  isDefault?: boolean;
};

export type UpdateColumnPatch = {
  title?: string;
  colorKey?: string | null;
  isDefault?: boolean;
};

export type CreateTicketPayload = {
  columnId: string;
  title: string;
  description?: string;
  priority?: TicketPriority;
  dueDate?: string | null;
  tags?: string[];
  assigneeIds?: string[];
  assignedAgentId?: string;
  executionMode?: TicketExecutionMode;
  planText?: string | null;
  planApproved?: boolean;
  scheduledFor?: string | null;
  processVersionIds?: string[];
  checklistDone?: number;
  checklistTotal?: number;
  attachmentsCount?: number;
  commentsCount?: number;
  beforeTicketId?: string | null;
};

export type UpdateTicketPatch = {
  columnId?: string;
  title?: string;
  description?: string;
  priority?: TicketPriority;
  dueDate?: string | null;
  tags?: string[];
  assigneeIds?: string[];
  assignedAgentId?: string;
  executionMode?: TicketExecutionMode;
  planText?: string | null;
  planApproved?: boolean;
  scheduledFor?: string | null;
  executionState?: TicketExecutionState;
  processVersionIds?: string[];
  executionWindowMinutes?: number;
  checklistDone?: number;
  checklistTotal?: number;
  attachmentsCount?: number;
  commentsCount?: number;
};

export type MoveTicketPayload = {
  toColumnId: string;
  beforeTicketId: string | null;
};

export type TicketAttachmentRecord = {
  id: string;
  ticketId: string;
  name: string;
  url: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
};

export type TicketSubtaskRecord = {
  id: string;
  ticketId: string;
  title: string;
  completed: boolean;
  position: number;
  checklistName: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateTicketSubtaskPayload = {
  title: string;
  checklistName?: string;
};

export type UpdateTicketSubtaskPatch = {
  title?: string;
  completed?: boolean;
  checklistName?: string;
};

export type TicketCommentRecord = {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorName: string;
  content: string;
  createdAt: string;
};

export type TicketActivityLevel = "info" | "success" | "warning" | "error";

export type TicketActivityRecord = {
  id: string;
  ticketId: string;
  source: string;
  event: string;
  details: string;
  level: TicketActivityLevel;
  actorName: string | null;
  actorEmail: string | null;
  occurredAt: string;
};

export type CreateTicketActivityPayload = {
  source?: string;
  event: string;
  details?: string;
  level?: TicketActivityLevel;
};

export type TaskDataAdapter = {
  signUp(email: string, password: string): Promise<AdapterUser | null>;
  signIn(email: string, password: string): Promise<AdapterUser | null>;
  signOut(): Promise<void>;
  getSession(): Promise<AdapterSession | null>;
  getUser(): Promise<AdapterUser | null>;
  listBoards(): Promise<BoardRecord[]>;
  getBoard(boardId: string): Promise<BoardRecord | null>;
  createBoard(payload: CreateBoardPayload): Promise<BoardRecord>;
  updateBoard(boardId: string, patch: UpdateBoardPatch): Promise<BoardRecord>;
  deleteBoard(boardId: string): Promise<void>;
  listColumns(boardId: string): Promise<ColumnRecord[]>;
  createColumn(boardId: string, payload: CreateColumnPayload): Promise<ColumnRecord>;
  updateColumn(columnId: string, patch: UpdateColumnPatch): Promise<ColumnRecord>;
  deleteColumn(columnId: string): Promise<void>;
  reorderColumns(boardId: string, orderedColumnIds: string[]): Promise<void>;
  listTickets(boardId: string): Promise<TicketRecord[]>;
  createTicket(boardId: string, payload: CreateTicketPayload): Promise<TicketRecord>;
  updateTicket(ticketId: string, patch: UpdateTicketPatch): Promise<TicketRecord>;
  deleteTicket(ticketId: string): Promise<void>;
  moveTicket(ticketId: string, payload: MoveTicketPayload): Promise<void>;
  reorderTickets(columnId: string, orderedTicketIds: string[]): Promise<void>;
  listTicketAttachments(ticketId: string): Promise<TicketAttachmentRecord[]>;
  uploadTicketAttachment(ticketId: string, file: File): Promise<TicketAttachmentRecord>;
  deleteTicketAttachment(attachmentId: string): Promise<void>;
  listTicketSubtasks(ticketId: string): Promise<TicketSubtaskRecord[]>;
  createTicketSubtask(ticketId: string, payload: CreateTicketSubtaskPayload): Promise<TicketSubtaskRecord>;
  updateTicketSubtask(subtaskId: string, patch: UpdateTicketSubtaskPatch): Promise<TicketSubtaskRecord>;
  deleteTicketSubtask(subtaskId: string): Promise<void>;
  renameTicketChecklist(ticketId: string, oldName: string, newName: string): Promise<void>;
  deleteTicketChecklist(ticketId: string, checklistName: string): Promise<void>;
  listTicketComments(ticketId: string): Promise<TicketCommentRecord[]>;
  createTicketComment(ticketId: string, content: string): Promise<TicketCommentRecord>;
  deleteTicketComment(commentId: string): Promise<void>;
  listTicketActivity(ticketId: string): Promise<TicketActivityRecord[]>;
  createTicketActivity(
    ticketId: string,
    payload: CreateTicketActivityPayload,
  ): Promise<TicketActivityRecord>;
};
