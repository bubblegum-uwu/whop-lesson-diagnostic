import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

// Phase 4A — HashRouter, not BrowserRouter: the frontend is a static
// GitHub Pages deployment with no server-side SPA-fallback routing
// configured, so a path-based route (e.g. /projects) would 404 on refresh
// under BrowserRouter. HashRouter keeps every route after "#" (e.g.
// /#/projects), which GitHub Pages always serves as index.html regardless
// of what follows the hash — refreshable without any server changes. This
// also keeps the Whop OAuth callback's query-string handling (App.tsx reads
// window.location.search directly) completely unaffected: HashRouter only
// ever reads/writes location.hash, never location.search.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
