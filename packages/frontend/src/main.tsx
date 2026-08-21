import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';

document.documentElement.setAttribute('data-mode', localStorage.getItem('tm-theme-mode') ?? 'dark');
document.documentElement.setAttribute('data-accent', localStorage.getItem('tm-theme-accent') ?? 'violet');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
