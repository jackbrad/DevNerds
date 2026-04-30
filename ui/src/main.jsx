import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { configureAmplify } from './auth/amplify-config';
import AuthGuard from './auth/AuthGuard';

configureAmplify();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGuard>
      <App />
    </AuthGuard>
  </StrictMode>
);
