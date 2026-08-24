import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router-dom';
import messenger from './messenger/module.js';
import stickers from './stickers/module.js';
import calendar from './calendar/module.js';
import polls from './polls/module.js';
import games from './games/module.js';
import profile from './profile/module.js';
import type { AppModuleDefinition, ComposerAction, MessageRendererProps, NavItem } from './types.js';

/**
 * Registered feature modules.
 *
 * Add a module by creating `modules/<name>/module.ts` and appending it here –
 * navigation, routes, chat renderers and composer actions follow automatically.
 */
export const appModules: AppModuleDefinition[] = [
  messenger,
  calendar,
  games,
  stickers,
  polls,
  profile,
];

export function moduleRoutes(): RouteObject[] {
  return appModules.flatMap((module) => module.routes ?? []);
}

export function moduleNavItems(): NavItem[] {
  return appModules
    .flatMap((module) => module.nav ?? [])
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function messageRenderers(): Record<string, ComponentType<MessageRendererProps>> {
  const renderers: Record<string, ComponentType<MessageRendererProps>> = {};
  for (const module of appModules) Object.assign(renderers, module.messageRenderers ?? {});
  return renderers;
}

export function composerActions(): ComposerAction[] {
  return appModules
    .flatMap((module) => module.composerActions ?? [])
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function initModules(): () => void {
  const teardowns = appModules.map((module) => module.init?.()).filter(Boolean) as (() => void)[];
  return () => teardowns.forEach((teardown) => teardown());
}
