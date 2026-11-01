/** IPC 抛出的错误会被 Electron 包一层前缀，展示前去掉，只留人能读懂的部分 */
export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}
