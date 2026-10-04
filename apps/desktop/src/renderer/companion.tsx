/**
 * The pet window's entry point.
 *
 * A separate document from the main window's, so neither has to know the other's
 * layout — and so the window that floats over the desktop does not carry the
 * rail, the settings panel and the header that the other one needs.
 */
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {Pet} from './Pet.js';

import './styles/tokens.css';
import './styles/global.css';
import './styles/companion.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('the companion has no #root to mount into');
}

createRoot(container).render(
  <StrictMode>
    <Pet />
  </StrictMode>,
);
