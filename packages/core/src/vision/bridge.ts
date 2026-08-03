/**
 * Vision Bridge — 为纯文本 LLM（DeepSeek）提供图片理解能力。
 *
 * 工作流：
 *   用户发图片 → QQ 适配器下载图片 → VisionBridge.describe() → GLM-4V-Flash 返回文字描述
 *   → 描述文本拼入 DeepSeek prompt → DeepSeek 基于文字描述回复
 *
 * GLM-4V-Flash：智谱免费视觉模型，OpenAI 兼容 API。
 * 关键差异：base64 不能带 data:image/...;base64, 前缀（纯 base64）。
 */
import { logger } from '../utils/logger.js';

export interface VisionConfig {
  baseUrl: string;   // https://open.bigmodel.cn/api/paas/v4
  apiKey: string;
  model?: string;    // default: glm-4v-flash
}

export class VisionBridge {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: VisionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model || 'glm-4v-flash';
  }

  /** 描述一张图片（URL 或文件路径）。返回 null 表示失败。 */
  async describe(imageUrl: string, prompt?: string): Promise<string | null> {
    const start = Date.now();
    try {
      // 1. 下载图片 → base64
      const base64 = await this.downloadAsBase64(imageUrl);
      if (!base64) return null;

      // 2. 调 GLM-4V-Flash（纯 base64，不带 data URI 前缀）
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: base64 } },
              { type: 'text', text: prompt || '请用1-2句话简要描述这张图片的内容。' },
            ],
          }],
          max_tokens: 200,
          temperature: 0.1,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        logger.warn(`[Vision] GLM-4V-Flash error ${resp.status}: ${errText.slice(0, 200)} (${Date.now() - start}ms)`);
        return null;
      }

      const data = await resp.json() as any;
      const text = data.choices?.[0]?.message?.content || '';
      const usage = data.usage ? `${data.usage.total_tokens}t` : '?';
      logger.info(`[Vision] ${this.model} → "${text.slice(0, 80)}" (${usage}, ${Date.now() - start}ms)`);
      return text || null;
    } catch (err: any) {
      logger.warn(`[Vision] describe failed: ${err.message} (${Date.now() - start}ms)`);
      return null;
    }
  }

  /** 批量描述多张图片（并发）。返回非 null 的描述数组。 */
  async describeAll(imageUrls: string[], prompt?: string): Promise<string[]> {
    const results = await Promise.all(imageUrls.map(url => this.describe(url, prompt)));
    return results.filter((r): r is string => r !== null);
  }

  /** 下载图片并转 base64（纯编码，无 data URI 前缀——GLM-4V 要求） */
  private async downloadAsBase64(imageUrl: string): Promise<string | null> {
    try {
      // 本地文件路径
      if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        const { readFileSync } = await import('fs');
        return readFileSync(imageUrl).toString('base64');
      }

      // HTTP(S) 远程下载
      const resp = await fetch(imageUrl);
      if (!resp.ok) {
        logger.warn(`[Vision] download failed ${resp.status}: ${imageUrl.slice(0, 80)}`);
        return null;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      return buffer.toString('base64');
    } catch (err: any) {
      logger.warn(`[Vision] download error: ${err.message}`);
      return null;
    }
  }
}
