<script setup lang="ts">
/**
 * 聊天视图(M3)— 流式对话,走完整 pipeline(记忆/人格/生活)
 * 表情包标记 [表情包:名字] → 渲染为贴图
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { chatApi, sessionApi } from '../api/modules';
import { streamChat } from '../api/client';
import { useAppStore } from '../stores/app';
import Live2DCanvas from '../components/live2d/Live2DCanvas.vue';
import { Pencil, Trash2, Archive, X } from 'lucide-vue-next';

const showPet = ref(true);

const app = useAppStore();
const route = useRoute();
const CURRENT_SESSION_KEY = 'aw-chat-session';
const NAMES_KEY = 'aw-chat-names';

const sessions = ref<Array<{ sessionId: string; messageCount: number; lastActive: string }>>([]);
/** ★ 裸会话 id(不含 webui:private: 前缀)——统一约定,避免前缀累积污染 */
const cleanSid = (id: string) => String(id ?? '').replace(/^(webui:private:)+/, '');
const currentId = ref(cleanSid(localStorage.getItem(CURRENT_SESSION_KEY) ?? ''));
const messages = ref<Array<{ role: string; content: string; createdAt?: string }>>([]);

// ── 会话自定义名称(localStorage 映射,跨重启持久)──
const sessionNames = ref<Record<string, string>>(JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}'));
const editingName = ref('');
const editingId = ref('');
let nameSeq = 0;
const saveNames = () => localStorage.setItem(NAMES_KEY, JSON.stringify(sessionNames.value));
const displayName = (id: string) => sessionNames.value[id] ?? id.replace(/^sess-/, '').slice(0, 10);
function beginRename(id: string) {
  editingId.value = id;
  editingName.value = sessionNames.value[id] ?? '';
}
function commitRename() {
  const name = editingName.value.trim();
  if (name) sessionNames.value[editingId.value] = name;
  else delete sessionNames.value[editingId.value];
  saveNames();
  editingId.value = '';
}

/** ★ 会话删除弹窗:归档(软删除,数据保留) / 彻底删除 / 取消 */
const deleteTarget = ref('');
const deleteBusy = ref(false);

function openDeleteDialog(id: string) {
  deleteTarget.value = id;
}
function closeDeleteDialog() {
  deleteTarget.value = '';
}

async function doArchive() {
  if (!deleteTarget.value) return;
  deleteBusy.value = true;
  try {
    await sessionApi.archive(deleteTarget.value);
    afterSessionRemoved(deleteTarget.value);
  } finally {
    deleteBusy.value = false;
    closeDeleteDialog();
  }
}

async function doDelete() {
  if (!deleteTarget.value) return;
  deleteBusy.value = true;
  try {
    await sessionApi.remove(deleteTarget.value);
    afterSessionRemoved(deleteTarget.value);
  } finally {
    deleteBusy.value = false;
    closeDeleteDialog();
  }
}

/** 删除/归档后:清名字映射 + 当前会话则切换 + 刷新列表 */
async function afterSessionRemoved(id: string) {
  delete sessionNames.value[id];
  saveNames();
  if (currentId.value === cleanSid(id)) {
    currentId.value = '';
    localStorage.removeItem(CURRENT_SESSION_KEY);
    messages.value = [];
  }
  await refreshSessions();
  if (!currentId.value && sessions.value.length > 0) {
    currentId.value = cleanSid(sessions.value[0].sessionId);
    localStorage.setItem(CURRENT_SESSION_KEY, currentId.value);
    await loadMessages();
  }
}
const input = ref('');
const sending = ref(false);
const streaming = ref(false);
const listEl = ref<HTMLElement | null>(null);
const error = ref('');
const abortCtrl = ref<AbortController | null>(null);

// ★ 8-15 思考区:reasoning 块不输出正文,进"思考中"折叠条(默认隐藏内容,复用 QQ thinking 文案风格)
const THINKING_LINES = [
  '想着你刚才说的话…',
  '在心里慢慢过了一遍…',
  '歪着头想了想…',
  '轻轻唔了一声…',
];
const thinking = ref({ active: false, text: '', line: '' });
const showThinking = ref(false);
let thinkingIdx = 0;

onMounted(async () => {
  await refreshSessions();
  // ★ 会话复用:优先 route query(?session=,来自会话管理页"继续聊")→
  //   localStorage 记住的会话 → 自动选最近的历史会话
  const fromQuery = cleanSid(String(route.query.session ?? ''));
  if (fromQuery) {
    currentId.value = fromQuery;
    localStorage.setItem(CURRENT_SESSION_KEY, fromQuery);
    await loadMessages();
  } else if (currentId.value) {
    await loadMessages();
  } else if (sessions.value.length > 0) {
    currentId.value = cleanSid(sessions.value[0].sessionId);
    localStorage.setItem(CURRENT_SESSION_KEY, currentId.value);
    await loadMessages();
  }
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
  sessionNames.value[currentId.value] = `会话 ${++nameSeq}`;
  saveNames();
  messages.value = [];
  refreshSessions();
}

function switchSession(id: string) {
  currentId.value = cleanSid(id);
  localStorage.setItem(CURRENT_SESSION_KEY, currentId.value);
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
  thinking.value = { active: false, text: '', line: THINKING_LINES[thinkingIdx++ % THINKING_LINES.length] };
  showThinking.value = false;
  scrollBottom();

  abortCtrl.value = new AbortController();
  try {
    await streamChat('/api/chat/stream', { text, sessionId: currentId.value }, (frame) => {
      if (frame.type === 'chunk') {
        if (frame.kind === 'reasoning') {
          // ★ 思考内容进思考区,绝不进正文(默认隐藏,可展开)
          thinking.value.active = true;
          thinking.value.text += String(frame.text ?? '');
        } else {
          assistant.value.content += String(frame.text ?? '');
          scrollBottom();
        }
      } else if (frame.type === 'done') {
        // 思考条保留(折叠态,streaming=false 显示"想好了"),内容可回看
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
      <div class="sessions-divider"></div>
      <div class="sessions">
        <div
          v-for="s in chatSessions"
          :key="s.sessionId"
          class="session-item"
          :class="{ active: s.sessionId === currentId }"
          @click="switchSession(s.sessionId)"
        >
          <template v-if="editingId === s.sessionId">
            <input
              v-model="editingName"
              class="rename-input"
              autofocus
              @click.stop
              @keydown.enter.stop="commitRename"
              @keydown.esc.stop="editingId = ''"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <span class="session-title">{{ displayName(s.sessionId) }}</span>
            <button class="rename-btn" title="重命名" @click.stop="beginRename(s.sessionId)">
              <Pencil :size="11" stroke-width="2" />
            </button>
            <button
              class="rename-btn del"
              title="删除会话"
              @click.stop="openDeleteDialog(s.sessionId)"
            >
              <Trash2 :size="11" stroke-width="2" />
            </button>
            <span class="session-count">{{ s.messageCount }}</span>
          </template>
        </div>
        <div v-if="!chatSessions.length" class="session-empty">还没有 WebUI 会话</div>
      </div>
    </aside>

    <!-- 对话区 -->
    <div class="chat-main">
      <div class="pet-corner" :class="{ hidden: !showPet }">
        <button class="pet-toggle" @click="showPet = !showPet">{{ showPet ? '✕ 收起小人' : '✦ 召唤小人' }}</button>
        <Live2DCanvas v-if="showPet" :width="220" :height="280" :interactive="true" />
      </div>
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
        <!-- ★ 思考条:转圈 + 第一人称文案;思考内容默认隐藏可展开。
             思考结束(done/aborted)后保留为折叠态(转圈停),不消失——"想完了"仍可回看 -->
        <div v-if="thinking.active" class="thinking" :class="{ done: !streaming }">
          <span v-if="streaming" class="spinner"></span>
          <span class="thinking-line">{{ streaming ? thinking.line : '想好了' }}</span>
          <button v-if="thinking.text" class="think-toggle" @click="showThinking = !showThinking">
            {{ showThinking ? '收起' : (streaming ? '看她在想什么' : '看她想了什么') }}
          </button>
          <div v-if="showThinking && thinking.text" class="think-content">{{ thinking.text }}</div>
        </div>
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

    <!-- ★ 删除会话弹窗:归档(数据保留) / 彻底删除 -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="dlg-overlay" @click.self="closeDeleteDialog">
        <div class="dlg-card">
          <h3 class="dlg-title">删除会话</h3>
          <p class="dlg-desc">
            「{{ displayName(deleteTarget) }}」的对话记录——<br />
            归档 = 从列表移除但数据保留;彻底删除 = 不可恢复。
          </p>
          <div class="dlg-actions">
            <button class="dlg-btn archive" :disabled="deleteBusy" @click="doArchive">
              <Archive :size="14" stroke-width="2" /> 删除并归档
            </button>
            <button class="dlg-btn danger" :disabled="deleteBusy" @click="doDelete">
              <Trash2 :size="14" stroke-width="2" /> 彻底删除
            </button>
            <button class="dlg-btn cancel" :disabled="deleteBusy" @click="closeDeleteDialog">
              <X :size="14" stroke-width="2" /> 取消
            </button>
          </div>
        </div>
      </div>
    </Teleport>
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
.sessions-divider {
  height: 1px; flex: 0 0 1px;
  background: var(--aw-border);
  margin: 2px 0 8px;
}
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
.rename-btn {
  display: none; align-items: center; justify-content: center;
  width: 20px; height: 20px; flex: 0 0 20px;
  border: none; border-radius: 5px; background: none;
  color: var(--aw-text-faint); cursor: pointer;
}
.session-item:hover .rename-btn { display: flex; }
.rename-btn:hover { color: var(--aw-gold); background: var(--aw-bg-hover); }
.rename-btn.del:hover { color: var(--aw-danger); }

/* 删除弹窗 */
.dlg-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(5, 3, 12, 0.6);
  backdrop-filter: blur(4px);
  display: grid; place-items: center;
  animation: dlgIn 0.18s var(--aw-ease);
}
@keyframes dlgIn { from { opacity: 0; } }
.dlg-card {
  width: min(400px, calc(100vw - 48px));
  background: var(--aw-bg-raised);
  border: 1px solid var(--aw-border-strong);
  border-radius: var(--aw-radius-lg);
  box-shadow: var(--aw-shadow-pop);
  padding: 22px 24px;
  animation: dlgCard 0.2s var(--aw-ease);
}
@keyframes dlgCard { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
.dlg-title { font-size: var(--aw-fs-lg); font-weight: 700; margin-bottom: 10px; }
.dlg-desc {
  font-size: var(--aw-fs-sm); color: var(--aw-text-dim); line-height: 1.8;
  margin-bottom: 18px;
}
.dlg-actions { display: flex; flex-direction: column; gap: 8px; }
.dlg-btn {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px 14px; border-radius: var(--aw-radius-md);
  font-size: var(--aw-fs-md); font-weight: 600;
  border: 1px solid var(--aw-border); background: var(--aw-bg-input);
  color: var(--aw-text-dim);
  transition: all var(--aw-dur) var(--aw-ease);
}
.dlg-btn:hover:not(:disabled) { color: var(--aw-text); border-color: var(--aw-border-strong); transform: translateY(-1px); }
.dlg-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dlg-btn.archive { color: var(--aw-gold-2); border-color: var(--aw-border-gold); background: var(--aw-bg-active); }
.dlg-btn.archive:hover:not(:disabled) { background: rgba(201, 160, 92, 0.18); }
.dlg-btn.danger { color: var(--aw-danger); border-color: rgba(248, 113, 113, 0.4); background: rgba(248, 113, 113, 0.06); }
.dlg-btn.danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.14); }
.rename-input {
  flex: 1; min-width: 0;
  background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border-gold); border-radius: 5px;
  padding: 3px 6px; font-size: var(--aw-fs-sm); font-family: inherit;
}
.rename-input:focus { outline: none; }
.session-empty { color: var(--aw-text-faint); font-size: var(--aw-fs-sm); text-align: center; padding: 20px 0; }

.chat-main { display: flex; flex-direction: column; min-width: 0; position: relative; }
.pet-corner {
  position: absolute; right: 12px; bottom: 12px; z-index: 5;
  transition: opacity var(--aw-dur) var(--aw-ease), transform var(--aw-dur) var(--aw-ease);
}
.pet-corner.hidden { opacity: 0; pointer-events: none; transform: translateY(10px); }
.pet-toggle {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%); z-index: 6;
  font-size: 10px; padding: 2px 8px; border-radius: var(--aw-radius-full);
  border: 1px solid var(--aw-border); background: var(--aw-bg-raised);
  color: var(--aw-text-faint); white-space: nowrap;
}
.pet-toggle:hover { color: var(--aw-gold); border-color: var(--aw-border-gold); }
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
  background: var(--aw-bg-active);
  border: 1px solid var(--aw-border-gold);
  border-bottom-right-radius: 6px;
  color: var(--aw-text);
}
.msg.assistant .bubble {
  background: var(--aw-bg-raised);
  border: 1px solid var(--aw-border);
  border-bottom-left-radius: 6px;
  box-shadow: var(--aw-shadow-card);
}
.cursor { color: var(--aw-gold); animation: blink 1s step-start infinite; }
@keyframes blink { 50% { opacity: 0; } }
.sticker { max-width: 120px; max-height: 120px; object-fit: contain; margin: 4px 0; }
.thinking {
  display: flex; align-items: center; gap: 8px;
  color: var(--aw-text-faint); font-size: var(--aw-fs-sm);
  padding: 6px 24px 10px; flex-wrap: wrap;
}
.spinner {
  width: 14px; height: 14px; flex: 0 0 14px; border-radius: 50%;
  border: 2px solid var(--aw-border-strong);
  border-top-color: var(--aw-gold);
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.thinking.done .thinking-line { color: var(--aw-text-dim); }
.think-toggle {
  font-size: var(--aw-fs-xs); color: var(--aw-text-faint);
  background: none; border: 1px solid var(--aw-border);
  border-radius: var(--aw-radius-full); padding: 2px 10px;
  margin-left: auto;
}
.think-toggle:hover { color: var(--aw-gold); border-color: var(--aw-border-gold); }
.think-content {
  flex-basis: 100%;
  background: var(--aw-bg-input); border: 1px solid var(--aw-border);
  border-radius: var(--aw-radius-sm); padding: 8px 12px;
  font-size: var(--aw-fs-xs); color: var(--aw-text-faint);
  line-height: 1.6; max-height: 140px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-word;
}

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
