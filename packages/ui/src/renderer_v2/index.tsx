import ReactDOM from 'react-dom/client'
import { App } from './App'
// Load order: global defines the legacy tokens (--font-ui etc) that
// tokens.scss references, so global MUST come first. Then the semantic
// token layer, then the kit styles, then visual polish.
import './styles/global.scss'
import './styles/tokens.scss'
import './styles/components/kit.scss'
import './styles/visualEnhancements.scss'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

// NOTE: Keep StrictMode off to avoid double-invoking effects that initialize xterm/pty sessions.
root.render(<App />)


