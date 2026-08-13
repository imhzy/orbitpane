import React, { createContext, useContext } from 'react';
import type { Conversation, Provider, DirItem, PermissionMode, ToastKind } from '../lib/types';
import type { Message } from '../lib/types';

export interface AppContextType {
  // Theme
  theme: 'dark' | 'light';
  toggleTheme: () => void;

  // Toast
  showToast: (msg: string, kind?: ToastKind) => void;

  // Drawer / Sidebar
  isDrawerOpen: boolean;
  setIsDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  drawerMode: 'sessions' | 'create';
  setDrawerMode: React.Dispatch<React.SetStateAction<'sessions' | 'create'>>;

  // Command Palette
  isCmdPaletteOpen: boolean;
  setIsCmdPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Conversations (from useConversations)
  conversations: Conversation[];
  isConversationsLoading: boolean;
  activeConv: Conversation | null;
  setActiveConv: (conv: Conversation | null) => void;
  deleteConversation: (e: React.MouseEvent, convId: number) => void;
  createConversation: () => void;
  loadConversations: (isInitial?: boolean) => Promise<Conversation | null> | void;
  selectConversation: (conv: Conversation) => void;
  updateConversation: (
    id: number,
    values: Partial<Pick<Conversation, 'name' | 'path' | 'provider' | 'is_pinned' | 'is_archived' | 'preferred_model' | 'permission_mode' | 'draft'>>,
    options?: { silent?: boolean },
  ) => Promise<Conversation | null>;

  // Workspace editing
  editingConvId: number | null;
  setEditingConvId: (id: number | null) => void;
  editingConvName: string;
  setEditingConvName: (name: string) => void;
  startEditingConv: (e: React.MouseEvent, conv: Conversation) => void;
  saveConvName: (convId: number) => void;

  // Providers & Models
  providers: Provider[];
  defaultProvider: string;
  selectedProvider: string;
  setSelectedProvider: (provider: string) => void;
  selectedPermissionMode: PermissionMode;
  setSelectedPermissionMode: (mode: PermissionMode) => void;
  models: string[];
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  loadModels: (providerId?: string) => void;
  loadProviders: () => void;
  getProviderBadge: (providerId?: string, providersCatalog?: Provider[]) => { text: string; type: string; className: string; Icon: React.ElementType };
  formatModelName: (id: string) => string;

  // File System (Create Workspace)
  workspaceRoots: string[];
  defaultWorkspaceRoot: string;
  currentPath: string;
  setCurrentPath: (path: string) => void;
  items: DirItem[];
  selectedDir: string;
  setSelectedDir: (dir: string) => void;
  newConvName: string;
  setNewConvName: (name: string) => void;
  loadDir: (path: string) => void;
  getBreadcrumbParts: (pathStr: string) => { name: string; fullPath: string }[];

  // Chat & WebSocket (from useWebSocket)
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  isHistoryLoading: boolean;
  clearMessages: () => void;
  summarizeMessages: () => void;
  isConnected: boolean;
  isReconnecting: boolean;
  connectWebSocket: (conv: Conversation, forceReconnection: boolean) => void;
  disconnectCurrentSocket: () => void;
  activeConvRef: React.MutableRefObject<Conversation | null>;
  isExporting: boolean;
  exportConversationAsImage: () => Promise<void>;
  
  // Others
  historyRequestRef: React.MutableRefObject<number>;
  isAgentThinking: boolean;
  isAgentThinkingRef: React.MutableRefObject<boolean>;
  pendingSendMessagesRef: React.MutableRefObject<Map<number, Array<{ content: string; model: string; provider: string }>>>;
  loadHistory: (convId: number, silent?: boolean) => void;
  socketRef: React.MutableRefObject<WebSocket | null>;
  socketConversationIdRef: React.MutableRefObject<number | null>;
}

export const AppContext = createContext<AppContextType | null>(null);

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
