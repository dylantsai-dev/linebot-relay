import { createApp } from 'vue'
import '@fontsource-variable/inter/index.css'
import './styles.css'
import App from './App.vue'
import { installTooltips } from './lib/tooltip'
import { registerPwa } from './lib/pwa'
createApp(App).mount('#app')
installTooltips()
registerPwa()
