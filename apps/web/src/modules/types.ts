import type { ComponentType, ReactNode } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { ConversationDto, MessageDto } from '@initiative/shared';

export interface MessageRendererProps {
  message: MessageDto & { pending?: boolean; failed?: boolean };
  conversation: ConversationDto | null;
  isMine: boolean;
}

export interface ComposerActionProps {
  conversationId: string;
  onClose: () => void;
}

export interface ComposerAction {
  key: string;
  label: string;
  /** Emoji or short glyph shown in the attachment sheet. */
  icon: string;
  order?: number;
  render: ComponentType<ComposerActionProps>;
}

export interface NavItem {
  path: string;
  label: string;
  icon: string;
  order?: number;
  /** Optional badge count (unread chats, invitations …). */
  useBadge?: () => number;
}

/**
 * A frontend feature module.
 *
 * The messenger is one of these – the calendar, polls, sticker studio and the
 * mini-games are siblings. A new area of the app means one folder plus a line in
 * `registry.ts`; routes, navigation entries, chat bubbles and composer actions
 * are picked up automatically.
 */
export interface AppModuleDefinition {
  key: string;
  title: string;
  description?: string;
  routes?: RouteObject[];
  nav?: NavItem[];
  /** Chat bubbles for the message types this module owns. */
  messageRenderers?: Record<string, ComponentType<MessageRendererProps>>;
  composerActions?: ComposerAction[];
  /** Runs once when the app boots with an authenticated session. */
  init?: () => void | (() => void);
  /** Optional element rendered once inside the app shell (sheets, listeners). */
  overlay?: ComponentType;
  overlayNode?: ReactNode;
}

export function defineWebModule(definition: AppModuleDefinition): AppModuleDefinition {
  return definition;
}
