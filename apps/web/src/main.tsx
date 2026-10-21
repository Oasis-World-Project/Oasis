import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp } from './app.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html 缺少 #root');

const { App } = createApp();
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
