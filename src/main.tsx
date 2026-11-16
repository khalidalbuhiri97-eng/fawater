import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './auth/AuthGate';
import { installAuthenticatedFetch } from './auth/authenticatedFetch';
import './index.css';

installAuthenticatedFetch();

createRoot(document.getElementById('root')!).render(
  <AuthGate><App /></AuthGate>
);
