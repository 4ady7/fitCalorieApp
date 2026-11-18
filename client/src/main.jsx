import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { applyTheme, readTheme } from './theme.js';
import './styles.css';

applyTheme(readTheme());
createRoot(document.getElementById('root')).render(<App />);
