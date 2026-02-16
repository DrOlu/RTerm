import { mountMobileWeb } from '../../../packages/mobile-web/src/main'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}

mountMobileWeb('root')
