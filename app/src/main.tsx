import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { createServices } from './api';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');

void createServices().then((services) => {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App services={services} />
      </BrowserRouter>
    </StrictMode>,
  );
});
