/// <reference types="vite/client" />
import type { BridgeApi } from '../../shared/types'

/**
 * preload 通过 contextBridge 注入到页面的唯一出口。
 * 声明放在渲染侧，而不是 src/preload/index.d.ts —— 后者与 index.ts 同名会被
 * TypeScript 当作后者的声明文件，declare global 就不再生效了。
 */
declare global {
  interface Window {
    api: BridgeApi
  }
}
