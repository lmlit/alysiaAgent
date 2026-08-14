<script setup lang="ts">
/**
 * 聊天视图(M3)— 流式对话,走完整 pipeline(记忆/人格/生活)
 * 表情包标记 [表情包:名字] → 渲染为贴图
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { chatApi, sessionApi } from '../api/modules';
import { streamChat } from '../api/client';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const CURRENT_SESSION_KEY = 'aw-chat-session';

const sessions = ref<Array<{ sessionId: string; messageCount: number; lastActive: string }>>([]);
const currentId = ref(localStorage.getItem(CURRENT_SESSION_KEY) ?? '');
const messages = ref<Array<{ role: string; content: string; createdAt?: string }>>([]);
const input = ref('');
const sending = ref(false);
const streaming = ref(false);
const listEl = ref<HTMLElement | null>(null);
const error = ref('');
const abortCtrl = ref<AbortController | null>(null);

onMounted(async () => {
  await refreshSessions();
  if (currentId.value) await loadMessages();
});

async function refreshSessions() {
  try {
    const r = await sessionApi.list();
    sessions.value = (r.sessions ?? []).filter(s => s.sessionId.startsWith('webui:'));
  } catch { /* 服务未起 */ }
}

async function loadMessages() {
  if (!currentId.value) return;
  try {
    const r = await sessionApi.messages(currentId.value, 100);
    messages.value = [...r.messages].reverse(); // 倒序 → 时间正序(旧→新)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function newSession() {
  currentId.value = `sess-${Date.now()}`;
  localStorage.setItem(CURRENT_SESSION_KEY, currentId.value);
  messages.value = [];
  refreshSessions();
}

function switchSession(id: string) {
  currentId.value = id;
  localStorage.setItem(CURRENT_SESSION_KEY, id);
  loadMessages();
}

async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  input.value = '';
  sending.value = true;
  streaming.value = true;
  error.value = '';

  if (!currentId.value) newSession();
  messages.value.push({ role: 'user', content: text });
  const assistant = ref({ role: 'assistant', content: '' });
  messages.value.push(assistant.value);
  scrollBottom();

  abortCtrl.value = new AbortController();
  try {
    await streamChat('/api/chat/stream', { text, sessionId: currentId.value }, (frame) => {
      if (frame.type === 'chunk') {
        assistant.value.content += String(frame.text ?? '');
        scrollBottom();
      } else if (frame.type === 'done') {
        if (frame.reply && !assistant.value.content) assistant.value.content = String(frame.reply);
        streaming.value = false;
        refreshSessions();
      } else if (frame.type === 'aborted') {
        if (!assistant.value.content) assistant.value.content = '（回复被打断，继续说的话我会重新接上）';
        streaming.value = false;
      } else if (frame.type === 'error') {
        assistant.value.content += String(frame.message ?? '（出错了）');
        streaming.value = false;
      }
    });
  } catch {
    streaming.value = false;
  } finally {
    sending.value = false;
    abortCtrl.value = null;
  }
}

function stop() {
  abortCtrl.value?.abort();
  streaming.value = false;
}

async function loadOlder() {
  if (!currentId.value || !messages.value.length) return;
  const oldest = messages.value[0].createdAt;
  if (!oldest) return;
  const r = await sessionApi.messages(currentId.value, 50, oldest);
  if (r.messages.length) messages.value = [...[...r.messages].reverse(), ...messages.value];
}

function scrollBottom() {
  nextTick(() => { if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight; });
}

/** [表情包:名字] 标记 → 贴图渲染 */
function renderContent(content: string) {
  const parts = content.split(/(\[表情包:[^\]]+\])/g);
  return parts.map((p, i) => {
    const m = p.match(/^\[表情包:(.+)\]$/);
    if (m) {
      return { type: 'sticker' as const, name: m[1], key: i };
    }
    return { type: 'text' as const, text: p, key: i };
  });
}

const chatSessions = computed(() => sessions.value);
</script>

<template>
  <div class="chat-shell">
    <!-- 会话侧栏 -->
    <aside class="session-list">
      <button class="new-btn" @click="newSession">＋ 新会话</button>
      <div class="sessions">
        <button
          v-for="s in chatSessions"
          :key="s.sessionId"
          class="session-item"
          :class="{ active: s.sessionId === currentId }"
          @click="switchSession(s.sessionId)"
        >
          <span class="session-title">{{ s.sessionId.replace('webui:', '').slice(0, 24) }}</span>
          <span class="session-count">{{ s.messageCount }}</span>
        </button>
        <div v-if="!chatSessions.length" class="session-empty">还没有 WebUI 会话</div>
      </div>
    </aside>

    <!-- 对话区 -->
    <div class="chat-main">
      <div ref="listEl" class="msg-list">
        <div v-if="error" class="err-banner">{{ error }}</div>
        <template v-for="m in messages" :key="m.createdAt ?? m.content">
          <div class="msg" :class="m.role">
            <div class="bubble">
              <template v-for="part in renderContent(m.content)" :key="part.key">
                <img
                  v-if="part.type === 'sticker'"
                  :src="`/api/stickers/file/${encodeURIComponent(part.name)}`"
                  class="sticker"
                  :alt="part.name"
                  @error="(e) => { (e.target as HTMLImageElement).style.display = 'none'; }"
                />
                <template v-else>{{ part.text }}</template>
              </template>
              <span v-if="streaming && m.role === 'assistant' && m === messages[messages.length - 1]" class="cursor">▍</span>
            </div>
          </div>
        </template>
        <div v-if="streaming" class="thinking">昔涟正在想着…</div>
      </div>

      <div class="composer">
        <textarea
          v-model="input"
          class="composer-input"
          placeholder="和昔涟说点什么…"
          rows="2"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <div class="composer-actions">
          <button v-if="streaming" class="btn stop" @click="stop">■ 停止</button>
          <button v-else class="btn send" :disabled="!input.trim() || sending" @click="send">发送 ↵</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-shell {
  display: grid;
  grid-template-columns: 210px 1fr;
  gap: 0;
  height: calc(100vh - var(--aw-topbar-h) - 48px);
  margin: -24px -28px;
}
.session-list {
  border-right: 1px solid var(--aw-border);
  background: var(--aw-bg-raised);
  padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
  overflow-y: auto;
}
.new-btn {
  padding: 8px 12px; border-radius: var(--aw-radius-md);
  border: 1px solid var(--aw-border-gold); background: rgba(232, 196, 106, 0.1);
  color: var(--aw-gold); font-size: var(--aw-fs-md);
  transition: all var(--aw-dur) var(--aw-ease);
}
.new-btn:hover { background: rgba(232, 196, 106, 0.18); }
.sessions { display: flex; flex-direction: column; gap: 4px; }
.session-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: var(--aw-radius-md);
  border: 1px solid transparent; background: none;
  color: var(--aw-text-dim); font-size: var(--aw-fs-sm); text-align: left;
}
.session-item:hover { background: var(--aw-bg-hover); color: var(--aw-text); }
.session-item.active { background: var(--aw-bg-active); color: var(--aw-gold); border-color: var(--aw-border-gold); }
.session-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-count { font-size: 11px; color: var(--aw-text-faint); }
.session-empty { color: var(--aw-text-faint); font-size: var(--aw-fs-sm); text-align: center; padding: 20px 0; }

.chat-main { display: flex; flex-direction: column; min-width: 0; }
.msg-list { flex: 1; overflow-y: auto; padding: 20px 24px; }
.err-banner {
  background: rgba(248, 113, 113, 0.1); border: 1px solid var(--aw-danger);
  color: var(--aw-danger); padding: 8px 14px; border-radius: var(--aw-radius-md);
  font-size: var(--aw-fs-sm); margin-bottom: 14px;
}
.msg { display: flex; margin-bottom: 14px; }
.msg.user { justify-content: flex-end; }
.bubble {
  max-width: 72%;
  padding: 10px 16px;
  border-radius: 16px;
  font-size: var(--aw-fs-md);
  line-height: 1.7;
  word-break: break-word;
  white-space: pre-wrap;
}
.msg.user .bubble {
  background: linear-gradient(135deg, rgba(124, 108, 240, 0.35), rgba(232, 196, 106, 0.25));
  border: 1px solid var(--aw-border-strong);
  border-bottom-right-radius: 4px;
}
.msg.assistant .bubble {
  background: var(--aw-bg-card);
  border: 1px solid var(--aw-border);
  border-bottom-left-radius: 4px;
}
.cursor { color: var(--aw-gold); animation: blink 1s step-start infinite; }
@keyframes blink { 50% { opacity: 0; } }
.sticker { max-width: 120px; max-height: 120px; object-fit: contain; margin: 4px 0; }
.thinking { color: var(--aw-text-faint); font-size: var(--aw-fs-sm); padding: 0 24px 8px; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.4; } }

.composer {
  border-top: 1px solid var(--aw-border);
  padding: 12px 16px;
  display: flex; gap: 12px; align-items: flex-end;
  background: var(--aw-bg-raised);
}
.composer-input {
  flex: 1;
  background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-md);
  padding: 10px 14px; font-size: var(--aw-fs-md); font-family: inherit;
  resize: none; max-height: 120px;
}
.composer-input:focus { outline: none; border-color: var(--aw-border-gold); }
.composer-actions { display: flex; gap: 8px; }
.btn {
  padding: 9px 18px; border-radius: var(--aw-radius-md);
  font-size: var(--aw-fs-md); font-weight: 600;
  border: 1px solid var(--aw-border); background: var(--aw-bg-input);
  color: var(--aw-text-dim);
}
.btn:hover:not(:disabled) { color: var(--aw-text); border-color: var(--aw-border-strong); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.send { color: var(--aw-gold); border-color: var(--aw-border-gold); background: rgba(232, 196, 106, 0.12); }
.btn.stop { color: var(--aw-danger); border-color: var(--aw-danger); }
</style>
