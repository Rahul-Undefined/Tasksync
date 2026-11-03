import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/global.css';
import { App } from './App';

function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
      <div className="grain" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Backdrop />
    <App />
  </StrictMode>,
);
