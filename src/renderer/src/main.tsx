import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('[renderer] #root 없음 - index.html 이 손상되었습니다');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
