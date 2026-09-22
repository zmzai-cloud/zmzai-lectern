/**
 * 个人 key 与本地设置（dataDir/settings.json，0600）。
 * 个人 key = relay 签发的 zrk_ key：配置后 harness 以 OpenAI 兼容 Bearer 方式
 * 直连 relay（不再依赖浏览器登录 cookie），用量计入用户 relay 账户。
 *
 * 凭据加密（N2c）：personalKey 落盘前用 AES-256-GCM 加密，密钥存独立文件
 * dataDir/.secret（0600，首次生成随机 32B）。读到旧版明文 key 时自动迁移为
 * 密文（旧文件仍 0600，风险窗口仅为「已泄露的旧文件」）。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { dataDir } from "./runtime-constants.js";
import type { PermissionAction, PermissionDomain, PermissionSettings } from "./types.js";

const settingsFile = resolve(dataDir, "settings.json");
const secretFile = resolve(dataDir, ".secret");

export type HarnessSettings = { personalKey?: string; personalKeyPrefix?: string; relayUrl?: string; ollamaUrl?: string; failoverEndpoints?: FailoverEndpointInput[] };

/** 降级端点（设置页可增删改，持久化在 settings.json）。apiKey 属敏感凭据，落盘前加密。 */
export type FailoverEndpointInput = { baseUrl: string; apiKey?: string; modelId?: string };

/** ---- 对称加密（AES-256-GCM）：密钥文件 0600，密文 base64(iv|tag|ct) ---- */

function secretKey(): Buffer {
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(secretFile)) {
    const key = Buffer.from(readFileSync(secretFile, "utf8").trim(), "hex");
    if (key.length === 32) return key;
  }
  const key = randomBytes(32);
  writeFileSync(secretFile, key.toString("hex"), { mode: 0o600 });
  return key;
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function decrypt(encoded: string): string | null {
  try {
    const buf = Buffer.from(encoded, "base64");
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null; // 密钥轮换/密文损坏：视为未配置，由用户重新录入
  }
}

/** ---- settings.json 读写（明文自动迁移为密文） ---- */

type StoredSettings = { personalKeyEnc?: string; personalKey?: string; personalKeyPrefix?: string; relayUrl?: string; ollamaUrl?: string; permissions?: Partial<Record<PermissionDomain, PermissionAction>>; failoverEndpoints?: StoredFailoverEndpoint[] };

type StoredFailoverEndpoint = { baseUrl: string; apiKeyEnc?: string; apiKey?: string; modelId?: string };

function readStored(): StoredSettings {
  try {
    if (!existsSync(settingsFile)) return {};
    return JSON.parse(readFileSync(settingsFile, "utf8")) as StoredSettings;
  } catch {
    return {};
  }
}

function write(next: StoredSettings) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function read(): HarnessSettings {
  const stored = readStored();
  const next: HarnessSettings = { relayUrl: stored.relayUrl, ollamaUrl: stored.ollamaUrl, personalKeyPrefix: stored.personalKeyPrefix };
  if (stored.personalKeyEnc) {
    next.personalKey = decrypt(stored.personalKeyEnc) ?? undefined;
  } else if (stored.personalKey) {
    // 旧版明文迁移：加密落盘并从 settings.json 删除明文
    next.personalKey = stored.personalKey;
    write({ ...stored, personalKeyEnc: encrypt(stored.personalKey), personalKey: undefined });
  }
  // 降级端点：apiKey 解密，旧版明文自动迁移为密文
  if (stored.failoverEndpoints?.length) {
    next.failoverEndpoints = stored.failoverEndpoints.map((ep) => {
      let apiKey = ep.apiKeyEnc ? (decrypt(ep.apiKeyEnc) ?? undefined) : undefined;
      if (ep.apiKey) {
        apiKey = ep.apiKey;
        ep.apiKeyEnc = encrypt(ep.apiKey);
        ep.apiKey = undefined;
      }
      return { baseUrl: ep.baseUrl, ...(apiKey ? { apiKey } : {}), ...(ep.modelId ? { modelId: ep.modelId } : {}) };
    });
  }
  return next;
}

export function getSettings(): HarnessSettings {
  return read();
}

/** ---- 权限自动执行（设置 → 通用 → 权限）：持久化在 settings.json，保存即生效 ---- */

const PERMISSION_DOMAINS: PermissionDomain[] = ["terminal", "edit", "task", "gitWrite"];

export function getPermissions(): PermissionSettings {
  const stored = readStored().permissions;
  const out: PermissionSettings = {};
  if (stored) {
    for (const domain of PERMISSION_DOMAINS) {
      if (stored[domain] === "auto" || stored[domain] === "ask") out[domain] = stored[domain];
    }
  }
  return out;
}

export function savePermissions(patch: PermissionSettings): PermissionSettings {
  const stored = readStored();
  const merged: Partial<Record<PermissionDomain, PermissionAction>> = { ...(stored.permissions ?? {}) };
  for (const domain of PERMISSION_DOMAINS) {
    if (patch[domain] === "auto" || patch[domain] === "ask") merged[domain] = patch[domain];
  }
  write({ ...stored, permissions: merged });
  return getPermissions();
}

/** 掩码展示（UI 只回显尾部 4 位）。 */
export function maskedKey(): { configured: boolean; masked?: string } {
  const key = read().personalKey;
  if (!key) return { configured: false };
  return { configured: true, masked: `${key.slice(0, 4)}****${key.slice(-4)}` };
}

/** 已绑 key 的 prefix（前 12 位，与 relay key 列表匹配用）；未配置返回 null。 */
export function keyPrefix(): string | null {
  return read().personalKeyPrefix ?? null;
}

export function savePersonalKey(key: string | null, relayUrl?: string | null, ollamaUrl?: string | null) {
  const next = readStored();
  if (key === null) {
    delete next.personalKeyEnc;
    // 无密文残留即不再需要密钥文件（P0：清除 key 时一并回收 .secret）
    try { unlinkSync(secretFile); } catch { /* 不存在则忽略 */ }
  } else next.personalKeyEnc = encrypt(key.trim());
  // prefix（前 12 位，与 relay 展示规则一致）：用于与 relay 账号 key 列表匹配「使用中」，非敏感
  if (key === null) delete next.personalKeyPrefix;
  else next.personalKeyPrefix = key.trim().slice(0, 12);
  delete next.personalKey; // 迁移残留清理
  // undefined = 不动该字段（部分保存互不干扰）；null/空串 = 清除（恢复默认）
  if (relayUrl !== undefined) next.relayUrl = relayUrl?.trim() || undefined;
  if (ollamaUrl !== undefined) next.ollamaUrl = ollamaUrl?.trim() || undefined;
  write(next);
}

/** 降级端点（设置页增删改）：apiKey 加密落盘，baseUrl 归一化（去尾部斜杠）。
 *  空列表 = 清除全部备用端点（恢复仅主端点）。 */
export function saveFailoverEndpoints(endpoints: FailoverEndpointInput[] | null): FailoverEndpointInput[] {
  const next = readStored();
  if (!endpoints || endpoints.length === 0) {
    delete next.failoverEndpoints;
    write(next);
    return [];
  }
  const cleaned = endpoints
    .map((ep) => ep.baseUrl?.trim())
    .filter((baseUrl): baseUrl is string => !!baseUrl)
    .map((baseUrl, i) => {
      const src = endpoints[i];
      const ep: StoredFailoverEndpoint = { baseUrl: baseUrl.replace(/\/$/, "") };
      if (src.apiKey?.trim()) ep.apiKeyEnc = encrypt(src.apiKey.trim());
      if (src.modelId?.trim()) ep.modelId = src.modelId.trim();
      return ep;
    });
  next.failoverEndpoints = cleaned;
  write(next);
  return getSettings().failoverEndpoints ?? [];
}

/** 降级端点读取（apiKey 已解密）。 */
export function getFailoverEndpoints(): FailoverEndpointInput[] {
  return read().failoverEndpoints ?? [];
}

/** 密钥轮换（P0）：生成新 .secret 并把已存的 personalKeyEnc 重加密迁移。
 *  用途：怀疑密钥文件泄露/定期轮换。无已存 key 时仅重置密钥文件。 */
export function rotateSecretKey(): boolean {
  const stored = readStored();
  const plain = stored.personalKeyEnc ? decrypt(stored.personalKeyEnc) : null;
  if (stored.personalKeyEnc && !plain) {
    // 旧密文已不可解（密钥文件丢失/损坏）：重置密钥并清掉死密文，等用户重录
    try { unlinkSync(secretFile); } catch { /* 不存在则忽略 */ }
    write({ ...stored, personalKeyEnc: undefined });
    return false;
  }
  try { unlinkSync(secretFile); } catch { /* 不存在则忽略 */ }
  const next = { ...stored, personalKeyEnc: plain ? encrypt(plain) : undefined };
  write(next);
  return plain !== null;
}

/** LLM 请求头：个人 key 优先（Bearer），否则透传浏览器登录 cookie。 */
export function authHeaders(cookie: string | null): Record<string, string> {
  const { personalKey } = read();
  if (personalKey) return { authorization: `Bearer ${personalKey}` };
  return cookie ? { cookie } : {};
}

/** 本地 Ollama 端点（OpenAI 兼容 /v1 基址）：settings 优先，env 兜底。 */
export function ollamaBase(): string | null {
  const url = read().ollamaUrl ?? process.env.OLLAMA_URL ?? null;
  return url ? url.replace(/\/$/, "") : null;
}
