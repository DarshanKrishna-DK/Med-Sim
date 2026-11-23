import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';
import './styles/indic.css';
import { clearAllConversationStorage } from './voice/conversationStore';
import { captureAssignmentFromUrl } from './assignments/client';

// Each browser load = fresh session. Old per-case chat history could otherwise
// leak the previous farewell into the next encounter.
clearAllConversationStorage();
// Teacher assignment link (/?assignment=<code>), next to the ?observe= check in the store.
captureAssignmentFromUrl();

// A deploy replaces the hashed chunks: a tab opened before it gets a blank screen
// on the next lazy import. Reload once to pick up the new build (not in a loop).
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('medsim:chunk-reload') || 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem('medsim:chunk-reload', String(Date.now()));
  } catch {
    /* storage blocked: still reload once, this page load */
  }
  e.preventDefault();
  window.location.reload();
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
