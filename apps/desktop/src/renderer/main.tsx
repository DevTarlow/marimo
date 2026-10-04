import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './App.js';

import './styles/tokens.css';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('the renderer has no #root to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
