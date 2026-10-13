/** 记忆服务 origin（K1）：生产固定 memory.zmzai.cloud；本地联调可指本地 zmzai-memory。 */
export function memoryApiBase(): string {
  return (process.env.MEMORY_API_URL ?? "https://memory.zmzai.cloud").replace(/\/+$/, "");
}
