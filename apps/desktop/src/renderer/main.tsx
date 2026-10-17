import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './App.js';

import './styles/tokens.css';
import './styles/global.css';

/*
 * The main window's density, set before React mounts so the first paint is the
 * size the window keeps. It is not a preference any more: the compact scale is
 * only the companion's now, and this window always has the roomier one. Doing it
 * here rather than in an effect is what keeps the rail from re-spacing itself one
 * frame after it appears.
 */
document.documentElement.dataset['density'] = 'comfortable';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('the renderer has no #root to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
