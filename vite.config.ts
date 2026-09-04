import { defineConfig } from 'vite';

export default defineConfig({
  // 子路径部署：DEPLOY_BASE=/towers/ 则产物引用全部收敛到该基座下；
  // 默认 '/' 保持根部署不变。运行时 fetch 走 assetUrl() 读同一基座。
  base: process.env.DEPLOY_BASE ?? '/',
  build: {
    // The final artifact is one inline module; do not emit a module-preload
    // polyfill that contains a dormant fetch() path.
    modulePreload: false,
  },
});
