/**
 * 昔涟 — 本地对话测试
 * Usage: cd packages/server && npx tsx src/quick-test.ts
 *
 * 加载完整人设 (soul + identity + system + style)，多轮对话。
 * 输入 /exit 退出，/clear 清空上下文。
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import * as readline from 'readline';

const PERSONA_DIR = resolve(process.cwd(), '..', 'core', 'src', 'persona');

// 加载人设
const personaFiles = ['soul.md', 'identity.md', 'system.md', '01_default.md'];
const systemPrompt = personaFiles
  .map(f => {
    const p = join(PERSONA_DIR, f);
    if (!existsSync(p)) return '';
    try { return readFileSync(p, 'utf-8').trim(); }
    catch { return ''; }
  })
  .filter(Boolean)
  .join('\n\n---\n\n');

const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.CHAT_MODEL || 'deepseek-v4-flash';

console.log('╔══════════════════════════╗');
console.log('║    昔涟 · ALYSIA         ║');
console.log('║  本地对话测试 — 已苏醒    ║');
console.log(`║  人设: ${systemPrompt.length} 字符      ║`);
console.log('╚══════════════════════════╝');
console.log('  输入 /exit 退出  /clear 清空记忆\n');

async function chat(prompt: string, history: Array<{ role: string; content: string }>): Promise<string> {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt },
  ];

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content || '(昔涟沉默了...)';
}

async function main() {
  const history: Array<{ role: string; content: string }> = [];
  let totalTokens = 0;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === '/exit') { console.log('\n昔涟轻轻点了点头，消失在记忆的涟漪中...\n'); break; }
    if (input === '/clear') { history.length = 0; console.log('  [记忆已清空]'); rl.prompt(); continue; }

    process.stdout.write('  ');
    const reply = await chat(input, history);

    // 保持最近 20 轮对话
    history.push({ role: 'user', content: input });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 40) history.splice(0, history.length - 40);

    console.log(reply.replace(/\n/g, '\n  '));
    rl.prompt();
  }

  rl.close();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
