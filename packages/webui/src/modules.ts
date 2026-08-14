/**
 * ★ 扩展点(PRD §8.1):导航模块表——二期编程模式 = 加一行 + 新建 views/programming/ 目录,
 * 不改动本文件以外的一期代码
 */
import type { Component } from 'vue';
import {
  MessageCircle, User, Moon, Sparkles, BookOpen, LayoutGrid,
  Clapperboard, Library, Clock3, BarChart3, Smile, type LucideIcon,
} from 'lucide-vue-next';

export interface ModuleDef {
  id: string;
  title: string;
  icon: LucideIcon;
  path: string;
  view: () => Promise<unknown>;
}

export const modules: ModuleDef[] = [
  { id: 'chat', title: '聊天', icon: MessageCircle, path: '/chat', view: () => import('./views/ChatView.vue') },
  { id: 'profile', title: '画像', icon: User, path: '/profile', view: () => import('./views/ProfileView.vue') },
  { id: 'persona', title: '人格', icon: Moon, path: '/persona', view: () => import('./views/PersonaView.vue') },
  { id: 'life', title: '生活', icon: Sparkles, path: '/life', view: () => import('./views/LifeView.vue') },
  { id: 'worldbook', title: '世界书', icon: BookOpen, path: '/worldbook', view: () => import('./views/WorldbookView.vue') },
  { id: 'templates', title: '生活模板', icon: LayoutGrid, path: '/templates', view: () => import('./views/TemplatesView.vue') },
  { id: 'roles', title: '角色', icon: Clapperboard, path: '/roles', view: () => import('./views/RolesView.vue') },
  { id: 'knowledge', title: '知识库', icon: Library, path: '/knowledge', view: () => import('./views/KnowledgeView.vue') },
  { id: 'sessions', title: '会话', icon: Clock3, path: '/sessions', view: () => import('./views/SessionsView.vue') },
  { id: 'stats', title: 'Token 统计', icon: BarChart3, path: '/stats', view: () => import('./views/StatsView.vue') },
  { id: 'stickers', title: '表情包', icon: Smile, path: '/stickers', view: () => import('./views/StickersView.vue') },
];
