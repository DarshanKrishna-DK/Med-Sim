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

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
