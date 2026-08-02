/**
 * 米游社文章爬图工具
 *
 * 用法:
 *   npx tsx scripts/fetch-miyoushe.ts <文章URL 或 post_id> [输出目录] [角色名]
 *
 * 示例:
 *   npx tsx scripts/fetch-miyoushe.ts https://www.miyoushe.com/sr/article/71311478
 *   npx tsx scripts/fetch-miyoushe.ts 71311478 ./data/stickers alysia
 *
 * 功能:
 *   1. 解析文章 → 提取 [标签, 图片URL] 对（标签来自图前的 <p> 文字）
 *   2. 下载图片到输出目录（标签做文件名）
 *   3. 生成角色包 JSON（worldbook content_type: image），可直接放入 data/roles/ 自动加载
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import { execSync } from 'child_process';

const API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0';

interface StickerEntry {
  label: string;
  url: string;
}

async function fetchPost(postId: string): Promise<any> {
  const resp = await fetch(`${API}?post_id=${postId}&read=1`, {
    headers: { 'User-Agent': UA, 'Referer': `https://www.miyoushe.com/sr/article/${postId}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text().catch(() => '')}`);
  const data = await resp.json();
  const post = data?.data?.post;
  if (!post) throw new Error(`文章不存在或解析失败: ${JSON.stringify(data).slice(0, 200)}`);
  return post;
}

/** 解析 content HTML → [标签, 图片URL] 对（标签 = 图片前最近的 <p> 文本） */
function parsePairs(html: string): StickerEntry[] {
  const pairs: StickerEntry[] = [];
  const pRe = /<p>([^<]*)<\/p>/g;
  // 注意：无 g flag（match 带 g 返回完整匹配而非捕获组）
  const imgRe = /<img[^>]*src="([^"]+)"/;

  for (const seg of html.split(/(?=<img)/)) {
    const labels = [...seg.matchAll(pRe)].map(m => m[1].trim()).filter(Boolean);
    const img = seg.match(imgRe);
    if (img && img[1]) {
      pairs.push({ label: labels.length > 0 ? labels[labels.length - 1] : '', url: img[1].split('?')[0] });
    }
  }
  return pairs;
}

function sanitize(name: string): string {
  return name.replace(/[^\w一-龥]/g, '_');
}

async function download(url: string, dest: string): Promise<boolean> {
  try {
    // Windows 下 curl 需要正斜杠路径
    const safeDest = dest.replace(/\\/g, '/');
    execSync(`curl -sL --max-time 30 -H "User-Agent: ${UA}" -H "Referer: https://www.miyoushe.com/sr/" -o "${safeDest}" "${url}"`);
    return existsSync(dest) && statSync(dest).size > 1000;
  } catch {
    return false;
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log('用法: npx tsx scripts/fetch-miyoushe.ts <文章URL 或 post_id> [输出目录] [角色名]');
    process.exit(1);
  }

  // 解析 post_id（支持 URL 或纯数字）
  const postId = arg.match(/\d{6,}/)?.[0] ?? arg;
  const outDir = resolve(process.argv[3] || './data/stickers');
  const role = process.argv[4] || 'alysia';

  console.log(`[1/4] 获取文章 ${postId}...`);
  const post = await fetchPost(postId);
  const subject = post.post?.subject || '(无标题)';
  console.log(`      标题: ${subject} | 作者: ${post.user?.nickname || '未知'}`);

  console.log('[2/4] 解析图片与标签...');
  const pairs = parsePairs(post.post?.content || '');
  if (pairs.length === 0) {
    console.log('      未找到图片，退出。');
    process.exit(1);
  }
  const labeled = pairs.filter(p => p.label);
  console.log(`      共 ${pairs.length} 张，其中 ${labeled.length} 张带标签`);

  console.log(`[3/4] 下载图片 → ${outDir}...`);
  mkdirSync(outDir, { recursive: true });
  const worldbook: any[] = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const ext = p.url.split('.').pop() || 'png';
    const filename = `${p.label ? sanitize(p.label) : `sticker_${i}`}.${ext}`;
    const dest = resolve(outDir, filename);
    const success = await download(p.url, dest);
    if (success) {
      ok++;
      if (p.label) {
        worldbook.push({
          trigger_keys: [p.label],
          content: `/data/stickers/${filename}`,
          content_type: 'image',
          priority: 5,
          cooldown_sec: 30,
          scope: 'chat',
        });
      }
      console.log(`  ✅ ${filename}`);
    } else {
      fail++;
      console.log(`  ❌ ${filename}`);
    }
  }
  console.log(`      完成: ${ok} 成功, ${fail} 失败`);

  console.log('[4/4] 生成角色包...');
  const rolePackage = {
    role,
    name: role,
    version: 1,
    worldbook,
  };
  const pkgFile = resolve(outDir, `../roles/${basename(outDir)}-role.json`);
  mkdirSync(resolve(outDir, '../roles'), { recursive: true });
  writeFileSync(pkgFile, JSON.stringify(rolePackage, null, 2));
  console.log(`      角色包已写入: ${pkgFile}`);
  console.log(`      放入 data/roles/ 目录后重启即自动加载表情包`);
}

main().catch(err => {
  console.error('失败:', err.message);
  process.exit(1);
});
