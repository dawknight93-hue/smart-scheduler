// Must come first: this copy's settings (home time zone etc.), then the clock that
// makes every Date read home time when this device is set elsewhere.
import './lib/appSettings';
import './lib/homeClock';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { loadAppSettings } from './lib/appSettingsLoader';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Saved settings (if any) load in the background; the defaults are the original setup.
void loadAppSettings().catch(() => undefined);
